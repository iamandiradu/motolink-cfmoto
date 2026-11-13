import { base64Decode, base64Encode, hex, utf8Decode, utf8Encode, view } from '../bytes';
import {
  DEFAULT_IDENTITY,
  buildClientInfoReply,
  buildProbe,
  buildTimeSyncReply,
  formatDashTime,
  handleControlFrame,
  isProbeAccepted,
} from '../control';
import {
  Cmd,
  ControlParser,
  FramingError,
  MediaCmd,
  MediaParser,
  encodeControl,
  encodeMedia,
  payloadJson,
} from '../frames';
import { handleMediaFrame, parseCaptureConfig } from '../media';
import { fallbackDashAddress, isWifiDirect, parsePairingQr } from '../qr';

describe('bytes', () => {
  it('round-trips utf8 and base64', () => {
    const text = 'CFMOTO-f46457 ▲▼ ü 🏍';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
    for (const sample of ['', 'a', 'ab', 'abc', 'abcd', text]) {
      const bytes = utf8Encode(sample);
      expect(base64Encode(bytes)).toBe(Buffer.from(sample, 'utf8').toString('base64'));
      expect(utf8Decode(base64Decode(base64Encode(bytes)))).toBe(sample);
    }
  });
});

describe('pairing QR', () => {
  const qr =
    'http://www.carbit.com.cn/downsdk/657/658/_sdk?modelid=37416&sn=peTz&action=9' +
    '&ssid=CFMOTO-f46457&pwd=59a9cddc94&auth=wpa2-psk&mac=6C:09:4A:0F:6C:F8&name=CFMOTO-f46457';

  it('reads the Wi-Fi credentials', () => {
    expect(parsePairingQr(qr)).toMatchObject({
      ssid: 'CFMOTO-f46457',
      password: '59a9cddc94',
      auth: 'wpa2-psk',
      mac: '6c:09:4a:0f:6c:f8',
      modelId: '37416',
      action: 9,
    });
  });

  it('lower-cases keys and decodes values', () => {
    const parsed = parsePairingQr('x://y?SSID=My%20Bike&PWD=a%26b#frag');
    expect(parsed).toMatchObject({ ssid: 'My Bike', password: 'a&b' });
  });

  it('rejects text without credentials', () => {
    expect(parsePairingQr('https://example.com')).toBeNull();
    expect(parsePairingQr('x://y?ssid=only')).toBeNull();
  });

  it('picks the dash address by transport', () => {
    expect(fallbackDashAddress({ ssid: 'CFMOTO-f46457', action: 9 })).toBe('192.168.0.1');
    expect(isWifiDirect({ ssid: 'DIRECT-CF-CFMOTO-805120', action: 8 })).toBe(true);
    expect(fallbackDashAddress({ ssid: 'DIRECT-CF-CFMOTO-805120', action: 8 })).toBe('192.168.49.1');
  });
});

describe('control framing', () => {
  it('encodes the probe exactly as captured from a working link', () => {
    const probe = buildProbe(DEFAULT_IDENTITY);
    expect(hex(probe.subarray(0, 16))).toBe('10 00 00 70 56 00 00 00 46 00 00 70 00 00 00 00');
    expect(utf8Decode(probe.subarray(16))).toBe(
      '{"phoneType":"Android","packageName":"com.cfmoto.cfmotointernational"}',
    );
  });

  it('encodes an empty heartbeat ack', () => {
    expect(hex(encodeControl(Cmd.HEARTBEAT_ACK))).toBe('01 00 00 70 10 00 00 00 11 00 00 70 00 00 00 00');
  });

  it('parses frames split across chunks and glued together', () => {
    const a = encodeControl(Cmd.SELECT_CAR_CTRL);
    const b = encodeControl(Cmd.CLIENT_INFO, { HUID: 'abc' });
    const stream = new Uint8Array([...a, ...b]);
    const parser = new ControlParser();
    expect(parser.push(stream.subarray(0, 5))).toEqual([]);
    expect(parser.push(stream.subarray(5, 20)).map((f) => f.cmd)).toEqual([Cmd.SELECT_CAR_CTRL]);
    const rest = parser.push(stream.subarray(20));
    expect(rest).toHaveLength(1);
    expect(payloadJson(rest[0])).toEqual({ HUID: 'abc' });
  });

  it('rejects a frame with a wrong magic', () => {
    const frame = encodeControl(Cmd.HEARTBEAT);
    frame[8] ^= 0xff;
    expect(() => new ControlParser().push(frame)).toThrow(FramingError);
  });

  it('accepts a probe reply only when status is true', () => {
    const [ok] = new ControlParser().push(encodeControl(Cmd.PROBE_REPLY, { status: true }));
    const [no] = new ControlParser().push(encodeControl(Cmd.PROBE_REPLY, { status: false }));
    expect(isProbeAccepted(ok)).toBe(true);
    expect(isProbeAccepted(no)).toBe(false);
  });
});

describe('control handshake', () => {
  const sent = (cmd: number, payload?: object | Uint8Array) => {
    const [frame] = new ControlParser().push(encodeControl(cmd, payload));
    return handleControlFrame(frame, new Date(2026, 10, 13, 9, 5, 7, 42));
  };
  const replies = (actions: ReturnType<typeof handleControlFrame>) =>
    actions.flatMap((a) => (a.type === 'send' ? new ControlParser().push(a.data) : []));

  it('acks channel selects and unknown notify frames with cmd+1', () => {
    for (const cmd of [Cmd.SELECT_CAR_CTRL, Cmd.SELECT_CAR_DATA, Cmd.QUERY_SPEED, Cmd.LOG_REPORT, 0x10460]) {
      const [reply] = replies(sent(cmd, { any: 1 }));
      expect(reply.cmd).toBe(cmd + 1);
      expect(reply.payload).toHaveLength(0);
    }
  });

  it('answers the heartbeat and ignores acks', () => {
    expect(replies(sent(Cmd.HEARTBEAT))[0].cmd).toBe(Cmd.HEARTBEAT_ACK);
    expect(sent(Cmd.HEARTBEAT_ACK)).toEqual([]);
    expect(sent(0x201c1)).toEqual([]);
  });

  it('surfaces CLIENT_INFO so the session can sign the HUID', () => {
    const actions = sent(Cmd.CLIENT_INFO, {
      HUID: 'HU-123',
      HUName: 'CFMOTO',
      sdkVersion: '0.9.29.1',
      socketTimeoutPeriodWifi: 9,
      supportScreenTouch: false,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'clientInfo',
      dash: { huid: 'HU-123', sdkVersion: '0.9.29.1', socketTimeoutSec: 9, supportScreenTouch: false },
    });
  });

  it('answers CHECK_SN with an ack and then the result, echoing the serial', () => {
    const [ack, result] = replies(sent(Cmd.CHECK_SN, { client_set: 'easy_conn', sn: 'DSXX' }));
    expect(ack.cmd).toBe(Cmd.CHECK_SN + 1);
    expect(result.cmd).toBe(Cmd.CHECK_SN_RESULT);
    expect(payloadJson(result)).toEqual({
      isOk: true,
      errCode: 0,
      errMsg: '',
      id: 'DSXX',
      client_set: 'easy_conn',
    });
  });

  it('builds the CLIENT_INFO reply with the spoofed app identity', () => {
    const [frame] = new ControlParser().push(
      buildClientInfoReply({
        identity: DEFAULT_IDENTITY,
        phoneUuid: 'uuid',
        publicKey: 'PUB',
        encryptedHuid: 'SIG',
      }),
    );
    expect(frame.cmd).toBe(Cmd.CLIENT_INFO_REPLY);
    expect(payloadJson(frame)).toMatchObject({
      pxcVersion: '1.0.2',
      phoneOs: 'Android',
      package: 'com.cfmoto.cfmotointernational',
      versionCode: 126,
      pubkey: 'PUB',
      encryptedHUID: 'SIG',
      supportH264IFrame: true,
      supportSyncCorrectTime: false,
    });
  });

  describe('time sync', () => {
    const request = (stamp: string) => {
      const body = new Uint8Array(45);
      view(body).setInt32(0, -2, true);
      view(body).setInt32(8, 7, true);
      body.set(utf8Encode(stamp), 16);
      return body;
    };
    const now = new Date(2026, 10, 13, 9, 5, 7, 42);

    it('formats the 29-character stamp', () => {
      expect(formatDashTime(now)).toBe('2026-11-13 09:05:07.042000000');
      expect(formatDashTime(now)).toHaveLength(29);
    });

    it('echoes a valid dash clock unchanged', () => {
      const body = request('2026-11-13 08:00:00.000000000');
      expect(buildTimeSyncReply(body, now)).toEqual(body);
    });

    it('overwrites an unset clock and keeps the header', () => {
      const reply = buildTimeSyncReply(request('1970-01-01 00:00:12.000000000'), now);
      expect(utf8Decode(reply.subarray(16))).toBe('2026-11-13 09:05:07.042000000');
      expect(view(reply).getInt32(8, true)).toBe(7);
    });

    it('never replies empty', () => {
      const [reply] = replies(sent(Cmd.HU_TIME_SYNC, new Uint8Array(0)));
      expect(reply.cmd).toBe(Cmd.HU_TIME_SYNC + 1);
      expect(reply.payload.length).toBe(45);
    });
  });
});

describe('media plane', () => {
  const capture = (w: number, h: number, fps = 30, encoder = 2) => {
    const body = new Uint8Array(40);
    const dv = view(body);
    dv.setInt16(0, w, true);
    dv.setInt16(2, h, true);
    dv.setInt32(4, fps, true);
    dv.setInt32(8, encoder, true);
    body[29] = 1;
    return body;
  };
  const run = (cmd: number, body?: Uint8Array) => {
    const [frame] = new MediaParser().push(encodeMedia(cmd, body, 99));
    return handleMediaFrame(frame);
  };
  const reply = (actions: ReturnType<typeof handleMediaFrame>) => {
    const send = actions.find((a) => a.type === 'send');
    if (!send || send.type !== 'send') throw new Error('no reply');
    return new MediaParser().push(send.data)[0];
  };

  it('rounds the requested panel down to a multiple of 16', () => {
    expect(parseCaptureConfig(capture(800, 386))).toMatchObject({ width: 800, height: 384 });
    expect(parseCaptureConfig(capture(720, 712))).toMatchObject({ width: 720, height: 704 });
    expect(parseCaptureConfig(capture(800, 951))).toMatchObject({ width: 800, height: 944 });
  });

  it('replies to CONFIG_CAPTURE with encoder, size and the extend flag', () => {
    const actions = run(MediaCmd.CONFIG_CAPTURE, capture(800, 386, 30, 0));
    expect(actions[0]).toMatchObject({ type: 'configure', config: { width: 800, height: 384, fps: 30 } });
    const frame = reply(actions);
    expect(frame.cmdType).toBe(MediaCmd.CONFIG_CAPTURE_REPLY);
    expect(frame.token).toBe(0);
    expect(hex(frame.body)).toBe('02 00 00 00 20 03 80 01 01');
  });

  it('answers version, heartbeat and extended config', () => {
    expect(hex(reply(run(MediaCmd.GET_VERSION)).body)).toBe('03 00 00 00 01 00 00 00');
    expect(reply(run(MediaCmd.HEARTBEAT)).cmdType).toBe(MediaCmd.HEARTBEAT_REPLY);
    expect(utf8Decode(reply(run(MediaCmd.CONFIG_EXTEND, utf8Encode('{}'))).body)).toBe('{"state":0}');
  });

  it('restarts the stream before acking DATA_START', () => {
    const actions = run(MediaCmd.DATA_START);
    expect(actions.map((a) => a.type)).toEqual(['startStream', 'send']);
  });

  it('decodes touch events', () => {
    const body = new Uint8Array(18);
    const dv = view(body);
    dv.setUint16(0, 2, true);
    dv.setUint16(2, 400, true);
    dv.setUint16(4, 192, true);
    dv.setUint16(6, 1, true);
    expect(run(MediaCmd.TOUCH, body)).toEqual([
      { type: 'touch', touch: { action: 'down', x: 400, y: 192, pointerId: 1 } },
    ]);
  });
});
