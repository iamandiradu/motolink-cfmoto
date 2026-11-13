/**
 * Link trace: a fixed-size ring buffer of wire events for diagnosing a ride
 * afterwards. Recording is cheap and never throws. Formatting redacts every
 * line the same way as the shared report, including JSON payload text, which
 * carries the dash unit id and serial.
 *
 * Video payload bytes are never kept: frames on the video port (10920) keep
 * only their kind and size.
 */
import { Cmd, MediaCmd, PORT_MEDIA_DATA, PORT_PROBE, PORT_CONTROL, PORT_MEDIA_CONTROL, cmdName } from '../protocol/frames';
import { redactText } from './report';

export type TraceDir = 'in' | 'out' | 'note';

export interface TraceEntry {
  /** Epoch ms. */
  t: number;
  dir: TraceDir;
  port: number | null;
  kind: string;
  bytes: number;
  /** First TRACE_HEX_BYTES bytes of the payload, lowercase hex. */
  hex?: string;
}

export interface TraceInput {
  dir: TraceDir;
  port: number | null;
  kind: string;
  /** Payload. Its length is used for `bytes` unless `bytes` is given. */
  data?: Uint8Array;
  bytes?: number;
  t?: number;
}

export const TRACE_MAX_ENTRIES = 400;
export const TRACE_HEX_BYTES = 48;

function toHex(data: Uint8Array, max: number): string {
  let out = '';
  const n = Math.min(data.length, max);
  for (let i = 0; i < n; i++) out += data[i].toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

export interface TraceBuffer {
  record(input: TraceInput): void;
  /** Records one encoded frame as sent or received on `port`, decoding its header. */
  recordFrame(dir: 'in' | 'out', port: number, frame: Uint8Array, t?: number): void;
  clear(): void;
  /** Oldest first. */
  snapshot(): TraceEntry[];
}

/** Heartbeats and clock sync arrive every second or two and would push the handshake out of the buffer. */
const QUIET_CONTROL = new Set<number>([Cmd.HEARTBEAT, Cmd.HEARTBEAT_ACK, Cmd.HU_TIME_SYNC, Cmd.HU_TIME_SYNC + 1]);
const QUIET_MEDIA = new Set<number>([MediaCmd.HEARTBEAT, MediaCmd.HEARTBEAT_REPLY, MediaCmd.DATA_NEXT]);

export function createTrace(maxEntries: number = TRACE_MAX_ENTRIES): TraceBuffer {
  const cap = Math.max(1, Math.floor(maxEntries));
  const ring: (TraceEntry | undefined)[] = new Array(cap);
  let next = 0;
  let size = 0;

  const record = (input: TraceInput): void => {
    try {
      const entry: TraceEntry = {
        t: input.t ?? Date.now(),
        dir: input.dir,
        port: input.port,
        kind: String(input.kind).slice(0, 64),
        bytes: input.bytes ?? input.data?.length ?? 0,
      };
      if (input.data && input.data.length > 0 && input.port !== PORT_MEDIA_DATA) {
        entry.hex = toHex(input.data, TRACE_HEX_BYTES);
      }
      ring[next] = entry;
      next = (next + 1) % cap;
      size = Math.min(size + 1, cap);
    } catch {
      // Diagnostics must never break the link.
    }
  };

  const recordFrame = (dir: 'in' | 'out', port: number, frame: Uint8Array, t?: number): void => {
    try {
      const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if ((port === PORT_CONTROL || port === PORT_PROBE) && frame.length >= 16) {
        const cmd = dv.getInt32(0, true) >>> 0;
        if (QUIET_CONTROL.has(cmd)) return;
        const payload = frame.subarray(16);
        record({ dir, port, kind: describeControl(cmd, payload.length), data: payload, bytes: frame.length, t });
      } else if ((port === PORT_MEDIA_CONTROL || port === PORT_MEDIA_DATA) && frame.length >= 8) {
        const cmdType = dv.getInt16(0, true);
        if (QUIET_MEDIA.has(cmdType)) return;
        const body = frame.subarray(8);
        record({ dir, port, kind: describeMedia(cmdType, body.length), data: body, bytes: frame.length, t });
      } else {
        record({ dir, port, kind: 'raw', data: frame, t });
      }
    } catch {
      // Never throws.
    }
  };

  return {
    record,
    recordFrame,
    clear() {
      ring.fill(undefined);
      next = 0;
      size = 0;
    },
    snapshot() {
      const out: TraceEntry[] = [];
      for (let i = 0; i < size; i++) {
        const entry = ring[(next - size + i + cap) % cap];
        if (entry) out.push({ ...entry });
      }
      return out;
    },
  };
}

/** The app-wide trace. */
export const linkTrace = createTrace();
export const record = linkTrace.record;
export const recordFrame = linkTrace.recordFrame;
export const clear = linkTrace.clear;
export const snapshot = linkTrace.snapshot;

/** Kind string for a control frame, e.g. "CLIENT_INFO (412)". */
export function describeControl(cmd: number, payloadLength: number): string {
  return `${cmdName(cmd >>> 0)} (${payloadLength})`;
}

/** Kind string for a media frame, e.g. "CONFIG_CAPTURE (12)". */
export function describeMedia(cmdType: number, bodyLength: number): string {
  for (const [name, value] of Object.entries(MediaCmd)) {
    if (value === cmdType) return `${name} (${bodyLength})`;
  }
  return `media ${cmdType} (${bodyLength})`;
}

/** Kind string for one H.264 access unit: NAL types only, never the bytes. */
export function describeVideo(accessUnit: Uint8Array): string {
  const types: number[] = [];
  for (let i = 0; i + 3 < accessUnit.length && types.length < 6; i++) {
    if (accessUnit[i] === 0 && accessUnit[i + 1] === 0) {
      const long = accessUnit[i + 2] === 0 && accessUnit[i + 3] === 1;
      const short = accessUnit[i + 2] === 1;
      if (long || short) {
        const at = i + (long ? 4 : 3);
        if (at < accessUnit.length) types.push(accessUnit[at] & 0x1f);
        i = at;
      }
    }
  }
  return `video nal ${types.length ? types.join('+') : '?'} (${accessUnit.length})`;
}

// ---------------------------------------------------------------------------
// Formatting

/** JSON fields that identify a unit or carry key material. Values are removed. */
const SECRET_KEYS =
  /"([A-Za-z_]*(?:huid|uuid|serial|mac|ssid|pwd|password|passwd|pubkey|publickey|vin|imei|token)[A-Za-z_]*|sn|id|key)"(\s*:\s*)("(?:[^"\\]|\\.)*"?|-?\d+)/gi;

/** Removes unit ids and secrets from JSON-ish text, then applies the report redaction. */
export function redactPayload(text: string, secrets: readonly string[]): string {
  return redactText(text.replace(SECRET_KEYS, '"$1"$2"[removed]"'), secrets);
}

function printableShare(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let printable = 0;
  for (const b of bytes) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d || b === 0x09) printable++;
  return printable / bytes.length;
}

function payloadView(hex: string, secrets: readonly string[]): string {
  const bytes = fromHex(hex);
  if (printableShare(bytes) >= 0.85) {
    let text = '';
    for (const b of bytes) text += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
    return `"${redactPayload(text, secrets)}"`;
  }
  return hex;
}

const DIR_MARK: Record<TraceDir, string> = { in: '<-', out: '->', note: '--' };

function stamp(ms: number): string {
  return `+${(ms / 1000).toFixed(3)}s`;
}

/**
 * Compact text, one line per event, timestamps relative to the first event.
 * Every line goes through the report redaction.
 */
export function formatTrace(entries: readonly TraceEntry[], secrets: readonly string[]): string {
  if (entries.length === 0) return 'Trace: empty';
  const start = entries[0].t;
  const lines = [`Trace (${entries.length} events, from ${new Date(start).toISOString()})`];
  for (const e of entries) {
    const port = e.port === null ? '' : ` :${e.port}`;
    const size = e.dir === 'note' && e.bytes === 0 ? '' : ` ${e.bytes}B`;
    const payload = e.hex && e.port !== PORT_MEDIA_DATA ? ` ${payloadView(e.hex, secrets)}` : '';
    const line = `${stamp(e.t - start)} ${DIR_MARK[e.dir]}${port} ${e.kind}${size}${payload}`;
    lines.push(redactPayload(line, secrets));
  }
  return lines.join('\n');
}
