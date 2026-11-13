/**
 * What a rider's own dash actually reported, kept per SSID. This is how the
 * 450 MT (and any bike nobody has recorded) gets real numbers: the first
 * connection fills the record, later ones keep it fresh.
 *
 * Pure: no storage here (see storage.ts), so it runs under Jest.
 */
import type { PhoneIdentity } from '../protocol/control';
import type { SessionSnapshot } from '../protocol/session';

export interface LearnedCapture {
  /** Size the dash asked for. */
  deviceWidth: number;
  deviceHeight: number;
  /** Size encoded (multiple of 16). */
  width: number;
  height: number;
  fps: number;
}

/** One identity the app introduced itself with, and whether the dash then showed the picture. */
export interface IdentityResult {
  phoneOs: string;
  supportFunction: number;
  /** The dash pulled video with this identity at least once. */
  streamed: boolean;
  lastTried: number;
}

export interface LearnedBike {
  /** Dash Wi-Fi name; the key. Stays on the phone, never exported in full. */
  ssid: string;
  modelId: string | null;
  sdkVersion: string | null;
  huName: string | null;
  capture: LearnedCapture | null;
  /** null when the dash never sent the field (parseDashInfo turns "absent" into false). */
  supportScreenTouch: boolean | null;
  identities: IdentityResult[];
  /** Profile the rider picked by hand for this bike, if any. */
  chosenProfileId: string | null;
  firstSeen: number;
  lastSeen: number;
}

export interface LearnInput {
  ssid: string;
  /** From the pairing QR. */
  modelId?: string | null;
  snapshot: SessionSnapshot;
  identity: Pick<PhoneIdentity, 'phoneOs' | 'supportFunction'>;
  now: number;
}

const MAX_IDENTITIES = 6;
/** lastSeen alone is not worth a storage write more often than this. */
const SEEN_RESOLUTION_MS = 10 * 60 * 1000;

export function emptyLearned(ssid: string, now: number): LearnedBike {
  return {
    ssid,
    modelId: null,
    sdkVersion: null,
    huName: null,
    capture: null,
    supportScreenTouch: null,
    identities: [],
    chosenProfileId: null,
    firstSeen: now,
    lastSeen: now,
  };
}

function touchFrom(snapshot: SessionSnapshot): boolean | null {
  const dash = snapshot.dash;
  if (!dash) return null;
  const raw = dash.raw.supportScreenTouch;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 1) return true;
  if (raw === 'false' || raw === 0) return false;
  return dash.supportScreenTouch ? true : null;
}

function sameCapture(a: LearnedCapture | null, b: LearnedCapture | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.deviceWidth === b.deviceWidth &&
    a.deviceHeight === b.deviceHeight &&
    a.width === b.width &&
    a.height === b.height &&
    a.fps === b.fps
  );
}

function sameIdentities(a: readonly IdentityResult[], b: readonly IdentityResult[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (x, i) => x.phoneOs === b[i].phoneOs && x.supportFunction === b[i].supportFunction && x.streamed === b[i].streamed,
    )
  );
}

function recordIdentity(
  list: readonly IdentityResult[],
  identity: Pick<PhoneIdentity, 'phoneOs' | 'supportFunction'>,
  streamed: boolean,
  now: number,
): IdentityResult[] {
  const existing = list.find((r) => r.phoneOs === identity.phoneOs && r.supportFunction === identity.supportFunction);
  const others = list.filter((r) => r !== existing);
  // streamed is sticky: one picture proves the identity works, a later drop does not undo that.
  const entry: IdentityResult = {
    phoneOs: identity.phoneOs,
    supportFunction: identity.supportFunction,
    streamed: streamed || (existing?.streamed ?? false),
    lastTried: now,
  };
  // Most recent first, so the newest working identity is found first.
  return [entry, ...others].slice(0, MAX_IDENTITIES);
}

/**
 * Folds one session snapshot into the record. Returns `previous` itself when
 * nothing worth saving changed, so callers can skip the write with `===`.
 * Nothing is learned until the dash has described itself: before that the
 * snapshot only says the bike was not reachable.
 */
export function learnFromSnapshot(previous: LearnedBike | null, input: LearnInput): LearnedBike | null {
  const { snapshot, now } = input;
  if (!snapshot.dash && !snapshot.capture) return previous;
  const base = previous && previous.ssid === input.ssid ? previous : emptyLearned(input.ssid, now);

  const capture: LearnedCapture | null = snapshot.capture
    ? {
        deviceWidth: snapshot.capture.deviceWidth,
        deviceHeight: snapshot.capture.deviceHeight,
        width: snapshot.capture.width,
        height: snapshot.capture.height,
        fps: snapshot.capture.fps,
      }
    : base.capture;

  const streamed = snapshot.state === 'streaming' || snapshot.framesSent > 0;
  const next: LearnedBike = {
    ...base,
    modelId: input.modelId ?? base.modelId,
    sdkVersion: snapshot.dash?.sdkVersion ?? base.sdkVersion,
    huName: snapshot.dash?.name ?? base.huName,
    capture: sameCapture(capture, base.capture) ? base.capture : capture,
    supportScreenTouch: touchFrom(snapshot) ?? base.supportScreenTouch,
    identities: snapshot.dash ? recordIdentity(base.identities, input.identity, streamed, now) : base.identities,
    lastSeen: now,
  };

  if (previous === base) {
    const unchanged =
      next.modelId === base.modelId &&
      next.sdkVersion === base.sdkVersion &&
      next.huName === base.huName &&
      next.capture === base.capture &&
      next.supportScreenTouch === base.supportScreenTouch &&
      sameIdentities(next.identities, base.identities);
    if (unchanged && now - base.lastSeen < SEEN_RESOLUTION_MS) return previous;
  }
  return next;
}

/** Records the rider's manual profile choice (null = back to automatic). */
export function chooseProfile(learned: LearnedBike, profileId: string | null): LearnedBike {
  return learned.chosenProfileId === profileId ? learned : { ...learned, chosenProfileId: profileId };
}

/** The most recent identity the dash streamed with, if any. */
export function workingIdentity(learned: LearnedBike | null): IdentityResult | null {
  // The list is kept most recent first.
  return learned?.identities.find((r) => r.streamed) ?? null;
}

/**
 * Combines two records of the same bike (for example a stored one and one
 * written by an older app version). The newer record wins per field; a
 * value never gets replaced by null.
 */
export function mergeLearned(a: LearnedBike, b: LearnedBike): LearnedBike {
  if (a.ssid !== b.ssid) throw new Error('mergeLearned: different bikes');
  const [older, newer] = a.lastSeen <= b.lastSeen ? [a, b] : [b, a];
  const identities = new Map<string, IdentityResult>();
  for (const r of [...older.identities, ...newer.identities]) {
    const key = `${r.phoneOs}/${r.supportFunction}`;
    const seen = identities.get(key);
    identities.set(key, seen ? { ...r, streamed: r.streamed || seen.streamed, lastTried: Math.max(r.lastTried, seen.lastTried) } : r);
  }
  return {
    ssid: newer.ssid,
    modelId: newer.modelId ?? older.modelId,
    sdkVersion: newer.sdkVersion ?? older.sdkVersion,
    huName: newer.huName ?? older.huName,
    capture: newer.capture ?? older.capture,
    supportScreenTouch: newer.supportScreenTouch ?? older.supportScreenTouch,
    identities: [...identities.values()].sort((x, y) => y.lastTried - x.lastTried).slice(0, MAX_IDENTITIES),
    chosenProfileId: newer.chosenProfileId ?? older.chosenProfileId,
    firstSeen: Math.min(a.firstSeen, b.firstSeen),
    lastSeen: Math.max(a.lastSeen, b.lastSeen),
  };
}

// ---- reading stored records -------------------------------------------------

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
}

function positiveInt(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max ? v : null;
}

function readCapture(v: unknown): LearnedCapture | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const deviceWidth = positiveInt(o.deviceWidth, 8192);
  const deviceHeight = positiveInt(o.deviceHeight, 8192);
  const width = positiveInt(o.width, 8192);
  const height = positiveInt(o.height, 8192);
  const fps = positiveInt(o.fps, 120);
  if (!deviceWidth || !deviceHeight || !width || !height || !fps) return null;
  return { deviceWidth, deviceHeight, width, height, fps };
}

function readIdentity(v: unknown): IdentityResult | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const phoneOs = strOrNull(o.phoneOs);
  const sf = o.supportFunction;
  if (!phoneOs || typeof sf !== 'number' || !Number.isInteger(sf)) return null;
  return {
    phoneOs,
    supportFunction: sf,
    streamed: o.streamed === true,
    lastTried: typeof o.lastTried === 'number' ? o.lastTried : 0,
  };
}

/** Validates a stored record; anything unreadable comes back null. */
export function normaliseLearned(v: unknown): LearnedBike | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const ssid = strOrNull(o.ssid);
  if (!ssid) return null;
  const firstSeen = typeof o.firstSeen === 'number' ? o.firstSeen : 0;
  const lastSeen = typeof o.lastSeen === 'number' ? o.lastSeen : firstSeen;
  return {
    ssid,
    modelId: strOrNull(o.modelId),
    sdkVersion: strOrNull(o.sdkVersion),
    huName: strOrNull(o.huName),
    capture: readCapture(o.capture),
    supportScreenTouch: typeof o.supportScreenTouch === 'boolean' ? o.supportScreenTouch : null,
    identities: Array.isArray(o.identities)
      ? o.identities.map(readIdentity).filter((r): r is IdentityResult => r !== null).slice(0, MAX_IDENTITIES)
      : [],
    chosenProfileId: strOrNull(o.chosenProfileId),
    firstSeen,
    lastSeen,
  };
}
