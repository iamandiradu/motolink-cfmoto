import { utf8Encode, view } from '../bytes';
import {
  Cmd,
  ControlFrame,
  ControlParser,
  MediaCmd,
  MediaParser,
  PORT_CONTROL,
  PORT_MEDIA_CONTROL,
  PORT_PROBE,
  encodeControl,
  encodeMedia,
  payloadJson,
} from '../frames';
import { parsePairingQr } from '../qr';
import { LinkSession, LinkTransport, NetworkInfo, SessionSnapshot, TransportEvent, VideoConfig } from '../session';

class FakeTransport implements LinkTransport {
  network: NetworkInfo = { ip: '192.168.0.50', gateway: '192.168.0.1' };
  probeAccepts = true;
  listener: ((event: TransportEvent) => void) | null = null;
  sent: { id: string; data: Uint8Array }[] = [];
  probes: { host: string; port: number }[] = [];
  joins: string[] = [];
  closed: string[] = [];
  video: VideoConfig | null = null;
  restarts = 0;
  serversStarted = 0;

  async joinWifi(ssid: string) {
    this.joins.push(ssid);
  }
  async getNetworkInfo() {
    return this.network;
  }
  async startServers() {
    this.serversStarted++;
  }
  async stopServers() {}
  async probe(host: string, port: number) {
    this.probes.push({ host, port });
    return encodeControl(Cmd.PROBE_REPLY, { status: this.probeAccepts });
  }
  send(id: string, data: Uint8Array) {
    this.sent.push({ id, data });
  }
  closeConnection(id: string) {
    this.closed.push(id);
    this.emit({ type: 'close', id, port: 0 });
  }
  async createIdentity() {
    return 'PUBKEY';
  }
  async signHuid(huid: string) {
    return `signed(${huid})`;
  }
  async configureVideo(config: VideoConfig) {
    this.video = config;
  }
  async restartStream() {
    this.restarts++;
  }
  async stopVideo() {}
  subscribe(listener: (event: TransportEvent) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: TransportEvent) {
    this.listener?.(event);
  }
  controlTo(id: string): ControlFrame[] {
    const parser = new ControlParser();
    return this.sent.filter((s) => s.id === id).flatMap((s) => parser.push(s.data));
  }
  mediaTo(id: string) {
    const parser = new MediaParser();
    return this.sent.filter((s) => s.id === id).flatMap((s) => parser.push(s.data));
  }
}

const creds = parsePairingQr('x://y?ssid=CFMOTO-f46457&pwd=secret&action=9&modelid=1')!;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('LinkSession', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(options = {}) {
    const transport = new FakeTransport();
    const states: SessionSnapshot['state'][] = [];
    const session = new LinkSession(
      transport,
      { onChange: (s) => states[states.length - 1] !== s.state && states.push(s.state) },
      options,
    );
    return { transport, session, states };
  }

  it('probes the gateway, then completes the handshake and starts video', async () => {
    const { transport, session, states } = setup();
    session.start(creds);
    await flush();

    expect(transport.serversStarted).toBe(1);
    expect(transport.probes[0]).toEqual({ host: '192.168.0.1', port: PORT_PROBE });
    expect(session.getSnapshot().state).toBe('waitingForDash');

    // Connection A: CAR_CTRL.
    transport.emit({ type: 'open', id: 'a', port: PORT_CONTROL });
    transport.emit({ type: 'data', id: 'a', port: PORT_CONTROL, data: encodeControl(Cmd.SELECT_CAR_CTRL) });
    transport.emit({
      type: 'data',
      id: 'a',
      port: PORT_CONTROL,
      data: encodeControl(Cmd.CLIENT_INFO, { HUID: 'HU-1', socketTimeoutPeriodWifi: 9 }),
    });
    await flush();
    const a = transport.controlTo('a');
    expect(a.map((f) => f.cmd)).toEqual([Cmd.SELECT_CAR_CTRL + 1, Cmd.CLIENT_INFO_REPLY]);
    expect(payloadJson(a[1])).toMatchObject({ pubkey: 'PUBKEY', encryptedHUID: 'signed(HU-1)' });
    expect(session.getSnapshot().dash?.huid).toBe('HU-1');

    // Connection B: CAR_DATA and the serial check.
    transport.emit({ type: 'open', id: 'b', port: PORT_CONTROL });
    transport.emit({
      type: 'data',
      id: 'b',
      port: PORT_CONTROL,
      data: encodeControl(Cmd.CHECK_SN, { client_set: 'easy_conn', sn: 'SN9' }),
    });
    expect(transport.controlTo('b').map((f) => f.cmd)).toEqual([Cmd.CHECK_SN + 1, Cmd.CHECK_SN_RESULT]);

    // Media control: the dash states its panel and starts pulling.
    const capture = new Uint8Array(32);
    view(capture).setInt16(0, 800, true);
    view(capture).setInt16(2, 386, true);
    view(capture).setInt32(4, 30, true);
    view(capture).setInt32(8, 2, true);
    transport.emit({ type: 'open', id: 'm', port: PORT_MEDIA_CONTROL });
    transport.emit({
      type: 'data',
      id: 'm',
      port: PORT_MEDIA_CONTROL,
      data: encodeMedia(MediaCmd.CONFIG_CAPTURE, capture),
    });
    await flush();
    expect(transport.video).toMatchObject({ width: 800, height: 384, fps: 30, bitrate: 1_500_000 });

    transport.emit({ type: 'data', id: 'm', port: PORT_MEDIA_CONTROL, data: encodeMedia(MediaCmd.DATA_START) });
    await flush();
    expect(transport.restarts).toBe(1);
    expect(transport.mediaTo('m').map((f) => f.cmdType)).toEqual([
      MediaCmd.CONFIG_CAPTURE_REPLY,
      MediaCmd.DATA_START_REPLY,
    ]);

    transport.emit({ type: 'videoStats', framesSent: 12, framesDropped: 0 });
    expect(session.getSnapshot().state).toBe('streaming');
    expect(states).toEqual(['searching', 'probing', 'waitingForDash', 'handshaking', 'negotiated', 'streaming']);
    await session.stop();
  });

  it('sends its own heartbeat on every control socket', async () => {
    const { transport, session } = setup();
    session.start(creds);
    await flush();
    transport.emit({ type: 'open', id: 'a', port: PORT_CONTROL });
    transport.emit({ type: 'open', id: 'b', port: PORT_CONTROL });
    transport.emit({ type: 'open', id: 'm', port: PORT_MEDIA_CONTROL });
    jest.advanceTimersByTime(2000);
    expect(transport.controlTo('a').map((f) => f.cmd)).toEqual([Cmd.HEARTBEAT]);
    expect(transport.controlTo('b').map((f) => f.cmd)).toEqual([Cmd.HEARTBEAT]);
    expect(transport.sent.filter((s) => s.id === 'm')).toHaveLength(0);
    await session.stop();
  });

  it('keeps retrying while the bike is off, and asks iOS to join its Wi-Fi', async () => {
    const { transport, session } = setup({ retryMs: 5000 });
    transport.network = { ip: null, gateway: null };
    session.start(creds);
    await flush();
    expect(transport.joins).toEqual(['CFMOTO-f46457']);
    expect(transport.probes).toHaveLength(0);
    expect(session.getSnapshot().state).toBe('searching');

    // Ignition on: the phone gets an address on the dash network.
    transport.network = { ip: '192.168.0.50', gateway: '192.168.0.1' };
    await jest.advanceTimersByTimeAsync(5000);
    await flush();
    expect(transport.probes.length).toBeGreaterThan(0);
    expect(session.getSnapshot().state).toBe('waitingForDash');
    await session.stop();
  });

  it('starts over when the dash drops every connection', async () => {
    const { transport, session } = setup();
    session.start(creds);
    await flush();
    transport.emit({ type: 'open', id: 'a', port: PORT_CONTROL });
    await flush();
    const probesBefore = transport.probes.length;

    transport.emit({ type: 'close', id: 'a', port: PORT_CONTROL });
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    expect(transport.probes.length).toBeGreaterThan(probesBefore);
    await session.stop();
  });

  it('closes the link when a control frame is corrupt', async () => {
    const { transport, session } = setup();
    session.start(creds);
    await flush();
    transport.emit({ type: 'open', id: 'a', port: PORT_CONTROL });
    const bad = encodeControl(Cmd.HEARTBEAT, utf8Encode('x'));
    bad[9] ^= 0x55;
    transport.emit({ type: 'data', id: 'a', port: PORT_CONTROL, data: bad });
    expect(transport.closed).toEqual(['a']);
    await session.stop();
  });
});
