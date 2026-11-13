/**
 * Media-control logic (port 10921). Pure: frames in, actions out.
 *
 * The dash dictates the picture size in CONFIG_CAPTURE (16). Video itself is
 * pulled on port 10920, one access unit per DATA_NEXT (114); that hot path is
 * served natively and never reaches JavaScript.
 */
import { utf8Encode, view } from './bytes';
import { MediaCmd, MediaFrame, encodeMedia } from './frames';

export interface CaptureConfig {
  /** Panel size the dash asked for. */
  deviceWidth: number;
  deviceHeight: number;
  /** Size to encode at: each dimension rounded down to a multiple of 16. */
  width: number;
  height: number;
  fps: number;
}

export interface TouchEvent {
  action: 'down' | 'move' | 'up';
  x: number;
  y: number;
  pointerId: number;
}

export type MediaAction =
  | { type: 'send'; data: Uint8Array }
  | { type: 'configure'; config: CaptureConfig }
  /** Dash is about to pull: flush queued frames and force SPS+PPS+IDR first. */
  | { type: 'startStream' }
  | { type: 'touch'; touch: TouchEvent }
  | { type: 'log'; message: string };

const H264 = 2;

export function parseCaptureConfig(body: Uint8Array): CaptureConfig | null {
  if (body.length < 12) return null;
  const dv = view(body);
  const deviceWidth = dv.getInt16(0, true);
  const deviceHeight = dv.getInt16(2, true);
  if (deviceWidth <= 0 || deviceHeight <= 0) return null;
  const fps = dv.getInt32(4, true);
  return {
    deviceWidth,
    deviceHeight,
    width: deviceWidth & 0xfff0,
    height: deviceHeight & 0xfff0,
    fps: fps > 0 && fps <= 60 ? fps : 30,
  };
}

function captureReply(body: Uint8Array, config: CaptureConfig): Uint8Array {
  const dv = view(body);
  const wantEncoder = dv.getInt32(8, true);
  const reply = new Uint8Array(9);
  const out = view(reply);
  out.setInt32(0, wantEncoder === 0 ? H264 : wantEncoder, true);
  out.setInt16(4, config.width, true);
  out.setInt16(6, config.height, true);
  reply[8] = body.length > 29 ? body[29] : 0;
  return reply;
}

export function parseTouch(body: Uint8Array): TouchEvent | null {
  if (body.length < 8) return null;
  const dv = view(body);
  const code = dv.getUint16(0, true);
  const action = code === 2 ? 'down' : code === 3 ? 'move' : code === 1 ? 'up' : null;
  if (!action) return null;
  return {
    action,
    x: dv.getUint16(2, true),
    y: dv.getUint16(4, true),
    pointerId: dv.getUint16(6, true),
  };
}

export function handleMediaFrame(frame: MediaFrame): MediaAction[] {
  switch (frame.cmdType) {
    case MediaCmd.CONFIG_CAPTURE: {
      const config = parseCaptureConfig(frame.body);
      if (!config) return [{ type: 'log', message: 'unreadable CONFIG_CAPTURE' }];
      return [
        { type: 'configure', config },
        { type: 'send', data: encodeMedia(MediaCmd.CONFIG_CAPTURE_REPLY, captureReply(frame.body, config)) },
      ];
    }
    case MediaCmd.GET_VERSION: {
      const body = new Uint8Array(8);
      view(body).setInt32(0, 3, true);
      view(body).setInt32(4, 1, true);
      return [{ type: 'send', data: encodeMedia(MediaCmd.GET_VERSION_REPLY, body) }];
    }
    case MediaCmd.HEARTBEAT:
      return [{ type: 'send', data: encodeMedia(MediaCmd.HEARTBEAT_REPLY) }];
    case MediaCmd.CONFIG_EXTEND:
      return [{ type: 'send', data: encodeMedia(MediaCmd.CONFIG_EXTEND_REPLY, utf8Encode('{"state":0}')) }];
    case MediaCmd.DATA_START:
      return [{ type: 'startStream' }, { type: 'send', data: encodeMedia(MediaCmd.DATA_START_REPLY) }];
    case MediaCmd.START_H264:
      return [{ type: 'send', data: encodeMedia(MediaCmd.START_H264_REPLY) }];
    case MediaCmd.TOUCH: {
      const touch = parseTouch(frame.body);
      return touch ? [{ type: 'touch', touch }] : [];
    }
    default:
      return [{ type: 'log', message: `unhandled media cmd ${frame.cmdType} (${frame.body.length} bytes)` }];
  }
}
