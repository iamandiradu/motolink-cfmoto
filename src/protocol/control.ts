/**
 * Control-plane logic (port 10922). Pure: frames in, actions out. The session
 * layer owns sockets, timers and the RSA key.
 *
 * Sequence (the dash dials in twice on 10922, then opens the media ports):
 *   A: 0x10000 select -> 0x10001
 *      0x10010 CLIENT_INFO (dash JSON) -> 0x10011 (phone JSON, needs RSA)
 *      0x10690 QUERY_SPEED -> 0x10691
 *   B: 0x20000 select -> 0x20001
 *      0x103e0 CHECK_SN -> 0x103e1, then 0x201c0 CHECK_SN_RESULT
 *   then a burst of notify frames. Each must be acked with cmd+1 or the dash
 *   never opens the media ports.
 */
import { utf8Encode, view } from './bytes';
import { Cmd, ControlFrame, encodeControl, payloadJson } from './frames';

/** Identity strings the dash sees. The Android values are the ones known to work. */
export interface PhoneIdentity {
  phoneOs: string;
  phoneType: string;
  packageName: string;
  versionCode: number;
  phoneBrand: string;
  phoneModel: string;
  phoneOsVersion: string;
  bluetoothName: string;
  /** 0 on legacy CFDL16 dashes, 128 on newer ones. */
  supportFunction: number;
  fingerprint: string;
}

export const DEFAULT_IDENTITY: PhoneIdentity = {
  phoneOs: 'Android',
  phoneType: 'Android',
  packageName: 'com.cfmoto.cfmotointernational',
  versionCode: 126,
  phoneBrand: 'Apple',
  phoneModel: 'iPhone',
  phoneOsVersion: '35',
  bluetoothName: 'MotoLink',
  supportFunction: 0,
  fingerprint: 'motolink',
};

export interface DashInfo {
  huid: string;
  name: string | null;
  sdkVersion: string | null;
  channel: string | null;
  supportScreenTouch: boolean;
  /** Seconds without a video frame before the dash drops the media link. */
  socketTimeoutSec: number | null;
  raw: Record<string, unknown>;
}

export type ControlAction =
  | { type: 'send'; data: Uint8Array }
  /** Dash described itself. Reply with buildClientInfoReply once the HUID is signed. */
  | { type: 'clientInfo'; dash: DashInfo }
  | { type: 'log'; message: string };

export function buildProbe(identity: PhoneIdentity): Uint8Array {
  return encodeControl(Cmd.PROBE, {
    phoneType: identity.phoneType,
    packageName: identity.packageName,
  });
}

/** The dash accepts the probe with {"status":true}. */
export function isProbeAccepted(frame: ControlFrame): boolean {
  if (frame.cmd !== Cmd.PROBE_REPLY) return false;
  const json = payloadJson(frame);
  return json?.status === true || json?.status === 'true';
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}

export function parseDashInfo(json: Record<string, unknown>): DashInfo {
  const timeout = Number(json.socketTimeoutPeriodWifi);
  return {
    huid: str(json.HUID) ?? str(json.huid) ?? '',
    name: str(json.HUName),
    sdkVersion: str(json.sdkVersion),
    channel: str(json.channel),
    supportScreenTouch: json.supportScreenTouch === true,
    socketTimeoutSec: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
    raw: json,
  };
}

export interface ClientInfoReplyInput {
  identity: PhoneIdentity;
  phoneUuid: string;
  /** base64 X.509 SubjectPublicKeyInfo of the session RSA-1024 key. */
  publicKey: string;
  /** base64 PKCS#1 v1.5 private-key operation over the dash HUID; "" when the dash sent none. */
  encryptedHuid: string;
}

/** Key order follows the reference implementation. */
export function buildClientInfoReply(input: ClientInfoReplyInput): Uint8Array {
  const { identity } = input;
  return encodeControl(Cmd.CLIENT_INFO_REPLY, {
    pxcVersion: '1.0.2',
    phoneUUID: input.phoneUuid,
    phoneBrand: identity.phoneBrand,
    phoneModel: identity.phoneModel,
    phoneOsVersion: identity.phoneOsVersion,
    phoneOs: identity.phoneOs,
    package: identity.packageName,
    versionCode: identity.versionCode,
    token: 0,
    pubkey: input.publicKey,
    encryptedHUID: input.encryptedHuid,
    bluetoothName: identity.bluetoothName,
    supportH264IFrame: true,
    supportFunction: identity.supportFunction,
    supportSyncCorrectTime: false,
    appVersionFingerPrint: identity.fingerprint,
  });
}

const STAMP_OFFSET = 16;
const STAMP_LENGTH = 29;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** yyyy-MM-dd HH:mm:ss.SSS000000, local time, 29 chars. */
export function formatDashTime(now: Date): string {
  return (
    `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)} ` +
    `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}.` +
    `${pad(now.getMilliseconds(), 3)}000000`
  );
}

/**
 * HU_TIME_SYNC (0x10600) reply body. Echo the dash's payload, unless its clock
 * is unset (blank or around 1970), in which case write the phone's local time.
 * Never reply empty: an empty 0x10601 resets some dash clocks to 1970.
 */
export function buildTimeSyncReply(request: Uint8Array, now: Date): Uint8Array {
  if (request.length < STAMP_OFFSET + STAMP_LENGTH) {
    const body = new Uint8Array(STAMP_OFFSET + STAMP_LENGTH);
    body.set(request.subarray(0, Math.min(request.length, STAMP_OFFSET)));
    if (request.length < 4) view(body).setInt32(0, -2, true);
    body.set(utf8Encode(formatDashTime(now)), STAMP_OFFSET);
    return body;
  }
  const reply = request.slice();
  let stamp = '';
  for (let i = 0; i < STAMP_LENGTH; i++) stamp += String.fromCharCode(reply[STAMP_OFFSET + i]);
  const year = Number.parseInt(stamp.slice(0, 4), 10);
  const unset = !/^\d{4}-\d{2}-\d{2}/.test(stamp) || (year >= 1969 && year <= 1971);
  if (unset) reply.set(utf8Encode(formatDashTime(now)), STAMP_OFFSET);
  return reply;
}

/** Replies carry the request id plus one; they need no answer. */
function isAck(cmd: number): boolean {
  return (cmd & 0xf) === 1;
}

/**
 * Handles one control frame from the dash. Dispatch is by command id, not by
 * which of the two 10922 connections it arrived on; reply on the same socket.
 */
export function handleControlFrame(frame: ControlFrame, now: Date = new Date()): ControlAction[] {
  const { cmd } = frame;
  if (isAck(cmd)) return [];

  switch (cmd) {
    case Cmd.CLIENT_INFO: {
      const json = payloadJson(frame);
      if (!json) return [{ type: 'log', message: 'CLIENT_INFO without JSON payload' }];
      return [{ type: 'clientInfo', dash: parseDashInfo(json) }];
    }
    case Cmd.CHECK_SN: {
      const json = payloadJson(frame);
      const sn = str(json?.sn) ?? '';
      const clientSet = str(json?.client_set) ?? 'easy_conn';
      return [
        { type: 'send', data: encodeControl(cmd + 1) },
        {
          type: 'send',
          data: encodeControl(Cmd.CHECK_SN_RESULT, {
            isOk: true,
            errCode: 0,
            errMsg: '',
            id: sn,
            client_set: clientSet,
          }),
        },
      ];
    }
    case Cmd.HU_TIME_SYNC:
      return [{ type: 'send', data: encodeControl(cmd + 1, buildTimeSyncReply(frame.payload, now)) }];
    default:
      // Channel selects, QUERY_SPEED, heartbeat and every notify frame: ack with cmd+1, empty.
      return [{ type: 'send', data: encodeControl(cmd + 1) }];
  }
}
