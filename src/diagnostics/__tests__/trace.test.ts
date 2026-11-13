import { Cmd, MediaCmd, PORT_CONTROL, PORT_MEDIA_DATA, encodeControl, encodeMedia } from '../../protocol/frames';
import {
  TRACE_HEX_BYTES,
  createTrace,
  describeControl,
  describeMedia,
  describeVideo,
  formatTrace,
} from '../trace';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('trace ring buffer', () => {
  it('keeps only the newest entries up to the cap', () => {
    const trace = createTrace(5);
    for (let i = 0; i < 12; i++) trace.record({ dir: 'note', port: null, kind: `e${i}`, t: 1000 + i });
    const entries = trace.snapshot();
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.kind)).toEqual(['e7', 'e8', 'e9', 'e10', 'e11']);
    trace.clear();
    expect(trace.snapshot()).toEqual([]);
  });

  it('truncates hex to the first 48 bytes but keeps the full size', () => {
    const trace = createTrace();
    trace.record({ dir: 'in', port: PORT_CONTROL, kind: 'x', data: new Uint8Array(200).fill(0xab), t: 0 });
    const [entry] = trace.snapshot();
    expect(entry.bytes).toBe(200);
    expect(entry.hex).toHaveLength(TRACE_HEX_BYTES * 2);
  });

  it('never keeps video payload bytes', () => {
    const trace = createTrace();
    const au = new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3, 0, 0, 1, 0x65, 9, 9, 9]);
    trace.record({ dir: 'out', port: PORT_MEDIA_DATA, kind: describeVideo(au), data: au, t: 0 });
    const [entry] = trace.snapshot();
    expect(entry.hex).toBeUndefined();
    expect(entry.kind).toBe(`video nal 7+8+5 (${au.length})`);
    expect(formatTrace([entry], [])).not.toMatch(/6765/);
  });

  it('recordFrame decodes headers and skips heartbeats', () => {
    const trace = createTrace();
    trace.recordFrame('in', PORT_CONTROL, encodeControl(Cmd.HEARTBEAT), 0);
    trace.recordFrame('in', PORT_CONTROL, encodeControl(Cmd.CLIENT_INFO, { a: 1 }), 1);
    trace.recordFrame('out', 10921, encodeMedia(MediaCmd.CONFIG_CAPTURE_REPLY, new Uint8Array(12)), 2);
    const entries = trace.snapshot();
    expect(entries.map((e) => e.kind)).toEqual(['CLIENT_INFO (7)', 'CONFIG_CAPTURE_REPLY (12)']);
    expect(entries[0].bytes).toBe(23);
  });

  it('describes control and media frames', () => {
    expect(describeControl(Cmd.CHECK_SN, 60)).toBe('CHECK_SN (60)');
    expect(describeMedia(MediaCmd.CONFIG_CAPTURE, 12)).toBe('CONFIG_CAPTURE (12)');
    expect(describeMedia(999, 3)).toBe('media 999 (3)');
  });
});

describe('formatTrace', () => {
  it('uses relative timestamps', () => {
    const trace = createTrace();
    trace.record({ dir: 'note', port: null, kind: 'state probing', t: 10_000 });
    trace.record({ dir: 'out', port: 10930, kind: 'PROBE (40)', bytes: 56, t: 11_250 });
    const text = formatTrace(trace.snapshot(), []);
    expect(text).toMatch(/^\+0\.000s -- state probing$/m);
    expect(text).toMatch(/^\+1\.250s -> :10930 PROBE \(40\) 56B$/m);
  });

  it('redacts the password, the SSID tail and the dash HUID inside payloads', () => {
    const trace = createTrace();
    const payload = utf8('{"huid":"a1b2c3d4e5f6","sn":"X9","name":"CFMOTO"}');
    trace.recordFrame('in', PORT_CONTROL, encodeControl(Cmd.CLIENT_INFO, payload), 0);
    trace.record({ dir: 'note', port: null, kind: 'join CFMOTO-f46457 pw hunter2secret', t: 5 });
    trace.record({ dir: 'note', port: null, kind: 'mac aa:bb:cc:dd:ee:ff id HU0123456789ABCDEF00', t: 6 });
    const text = formatTrace(trace.snapshot(), ['hunter2secret', 'CFMOTO-f46457']);
    expect(text).not.toContain('a1b2c3d4e5f6');
    expect(text).not.toContain('"X9"');
    expect(text).not.toContain('hunter2secret');
    expect(text).not.toContain('f46457');
    expect(text).not.toContain('aa:bb:cc:dd:ee:ff');
    expect(text).not.toContain('HU0123456789ABCDEF00');
    expect(text).toContain('"huid":"[removed]"');
  });

  it('redacts a HUID cut off by the hex limit', () => {
    const trace = createTrace();
    const payload = utf8(`{"padding":"${'x'.repeat(24)}","huid":"abcdef0123456789abcdef"}`);
    trace.record({ dir: 'in', port: PORT_CONTROL, kind: 'CLIENT_INFO', data: payload, t: 0 });
    const text = formatTrace(trace.snapshot(), []);
    expect(text).toContain('"huid":"[removed]"');
    expect(text).not.toMatch(/abcdef0/);
  });

  it('says so when empty', () => {
    expect(formatTrace([], [])).toBe('Trace: empty');
  });
});
