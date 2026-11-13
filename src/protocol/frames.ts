/**
 * Wire framing of the Carbit EasyConn ("PXC") link.
 *
 * Control plane (ports 10930 and 10922), 16-byte little-endian header:
 *   int32 cmd | int32 totalLen (16 + payload) | int32 magic (cmd XOR totalLen) | int32 0
 *
 * Media plane (ports 10921 and 10920), 8-byte little-endian header:
 *   int16 cmdType | uint16 bodyLen | int32 token
 */
import { ByteQueue, concatBytes, utf8Decode, utf8Encode, view } from './bytes';

export const PORT_PROBE = 10930;
export const PORT_CONTROL = 10922;
export const PORT_MEDIA_CONTROL = 10921;
export const PORT_MEDIA_DATA = 10920;

export const CONTROL_HEADER = 16;
export const MEDIA_HEADER = 8;
/** Guard against a corrupt length taking the parser hostage. */
const MAX_CONTROL_FRAME = 4 * 1024 * 1024;

export const Cmd = {
  PROBE: 0x70000010,
  PROBE_REPLY: 0x70000011,
  HEARTBEAT: 0x70000000,
  HEARTBEAT_ACK: 0x70000001,
  SELECT_CAR_CTRL: 0x10000,
  SELECT_CAR_DATA: 0x20000,
  CLIENT_INFO: 0x10010,
  CLIENT_INFO_REPLY: 0x10011,
  MEDIA_FEATURE_CFG: 0x10020,
  CHECK_SN: 0x103e0,
  CHECK_SN_RESULT: 0x201c0,
  OTA_FTP_INFO: 0x103a0,
  HU_QUERY_TIME: 0x10450,
  SOCK_SERVER_INFO: 0x104a0,
  HU_TIME_SYNC: 0x10600,
  QUERY_SPEED: 0x10690,
  LOG_REPORT: 0x10780,
} as const;

export const MediaCmd = {
  CONFIG_CAPTURE: 16,
  CONFIG_CAPTURE_REPLY: 17,
  TOUCH: 32,
  GET_VERSION: 48,
  GET_VERSION_REPLY: 49,
  HEARTBEAT: 64,
  HEARTBEAT_REPLY: 65,
  CONFIG_EXTEND: 96,
  CONFIG_EXTEND_REPLY: 97,
  DATA_START: 112,
  DATA_START_REPLY: 113,
  DATA_NEXT: 114,
  START_H264: 128,
  START_H264_REPLY: 129,
} as const;

export interface ControlFrame {
  cmd: number;
  payload: Uint8Array;
}

export interface MediaFrame {
  cmdType: number;
  token: number;
  body: Uint8Array;
}

const EMPTY = new Uint8Array(0);

export function encodeControl(cmd: number, payload: Uint8Array | string | object = EMPTY): Uint8Array {
  const body =
    payload instanceof Uint8Array
      ? payload
      : utf8Encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const total = CONTROL_HEADER + body.length;
  const head = new Uint8Array(CONTROL_HEADER);
  const dv = view(head);
  dv.setInt32(0, cmd | 0, true);
  dv.setInt32(4, total, true);
  dv.setInt32(8, (cmd ^ total) | 0, true);
  dv.setInt32(12, 0, true);
  return concatBytes(head, body);
}

export function encodeMedia(cmdType: number, body: Uint8Array = EMPTY, token = 0): Uint8Array {
  const head = new Uint8Array(MEDIA_HEADER);
  const dv = view(head);
  dv.setInt16(0, cmdType, true);
  dv.setUint16(2, body.length, true);
  dv.setInt32(4, token | 0, true);
  return concatBytes(head, body);
}

export class FramingError extends Error {}

/** Incremental parser for a control-plane TCP stream. */
export class ControlParser {
  private readonly queue = new ByteQueue();

  push(chunk: Uint8Array): ControlFrame[] {
    this.queue.push(chunk);
    const frames: ControlFrame[] = [];
    while (this.queue.length >= CONTROL_HEADER) {
      const dv = view(this.queue.peek());
      const cmd = dv.getInt32(0, true) >>> 0;
      const total = dv.getInt32(4, true);
      const magic = dv.getInt32(8, true);
      if (((cmd ^ total) | 0) !== magic) {
        this.queue.clear();
        throw new FramingError(`bad magic for cmd 0x${cmd.toString(16)}`);
      }
      if (total < CONTROL_HEADER || total > MAX_CONTROL_FRAME) {
        this.queue.clear();
        throw new FramingError(`bad length ${total} for cmd 0x${cmd.toString(16)}`);
      }
      if (this.queue.length < total) break;
      const raw = this.queue.take(total);
      frames.push({ cmd, payload: raw.subarray(CONTROL_HEADER) });
    }
    return frames;
  }
}

/** Incremental parser for a media-plane TCP stream. */
export class MediaParser {
  private readonly queue = new ByteQueue();

  push(chunk: Uint8Array): MediaFrame[] {
    this.queue.push(chunk);
    const frames: MediaFrame[] = [];
    while (this.queue.length >= MEDIA_HEADER) {
      const dv = view(this.queue.peek());
      const len = dv.getUint16(2, true);
      if (this.queue.length < MEDIA_HEADER + len) break;
      const cmdType = dv.getInt16(0, true);
      const token = dv.getInt32(4, true);
      const raw = this.queue.take(MEDIA_HEADER + len);
      frames.push({ cmdType, token, body: raw.subarray(MEDIA_HEADER) });
    }
    return frames;
  }
}

export function payloadText(frame: ControlFrame): string {
  return utf8Decode(frame.payload);
}

export function payloadJson(frame: ControlFrame): Record<string, unknown> | null {
  if (frame.payload.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(payloadText(frame));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function cmdName(cmd: number): string {
  for (const [name, value] of Object.entries(Cmd)) if (value === cmd) return name;
  return `0x${cmd.toString(16)}`;
}
