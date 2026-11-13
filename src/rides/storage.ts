/**
 * Saved rides in AsyncStorage.
 *
 * Layout:
 *   INDEX_KEY          -> RideSummary[] newest first (cheap to list)
 *   POINTS_PREFIX + id -> { v, summary, points } for one ride
 *
 * Each ride entry repeats its summary so a lost or corrupt index can be rebuilt
 * from the entries themselves instead of orphaning every ride.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Ride, RidePoint, RideSummary } from './recorder';

export const INDEX_KEY = 'motolink.rides.index.v1';
export const POINTS_PREFIX = 'motolink.rides.ride.v1.';
/** Oldest rides are dropped past this. Bounds storage at roughly MAX_RIDES x 300 KB. */
export const MAX_RIDES = 50;

/** Stored point: [t, lat, lon, ele?]. Arrays instead of objects roughly halve the size. */
type StoredPoint = [number, number, number] | [number, number, number, number];
interface StoredRide {
  v: 1;
  summary: RideSummary;
  points: StoredPoint[];
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));

function packPoint(p: RidePoint): StoredPoint {
  const base: [number, number, number] = [p.t, round(p.lat, 7), round(p.lon, 7)];
  return p.ele === undefined ? base : [...base, round(p.ele, 1)];
}

function unpackPoint(raw: unknown): RidePoint | null {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [t, lat, lon, ele] = raw as unknown[];
  if (typeof t !== 'number' || typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const point: RidePoint = { t, lat, lon };
  if (typeof ele === 'number' && Number.isFinite(ele)) point.ele = ele;
  return point;
}

const NUMBER_FIELDS = [
  'startedAt',
  'endedAt',
  'distanceM',
  'movingSeconds',
  'totalSeconds',
  'maxSpeedKmh',
  'avgSpeedKmh',
  'elevationGainM',
  'pointCount',
] as const;

export function isRideSummary(value: unknown): value is RideSummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  return NUMBER_FIELDS.every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
}

function parse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const byNewest = (a: RideSummary, b: RideSummary) => b.startedAt - a.startedAt;

/**
 * Mutations run one at a time. Save and delete both read-modify-write the
 * index; two at once (Stop then an immediate Delete) would lose one update.
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<RideSummary[]> {
  const parsed = parse(await AsyncStorage.getItem(INDEX_KEY));
  if (Array.isArray(parsed)) return parsed.filter(isRideSummary).sort(byNewest);
  // Missing (fresh install, or the index write was lost) or corrupt: rebuild
  // from the ride entries. On a fresh install that finds nothing.
  return rebuildIndex();
}

/** Recovers the index from the ride entries. Corrupt entries are removed. */
async function rebuildIndex(): Promise<RideSummary[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(POINTS_PREFIX));
  if (keys.length === 0) return [];
  const entries = await AsyncStorage.multiGet(keys);
  const summaries: RideSummary[] = [];
  const broken: string[] = [];
  for (const [key, raw] of entries) {
    const parsed = parse(raw) as Partial<StoredRide> | null;
    if (parsed && isRideSummary(parsed.summary) && POINTS_PREFIX + parsed.summary.id === key) summaries.push(parsed.summary);
    else broken.push(key);
  }
  if (broken.length) await AsyncStorage.multiRemove(broken);
  summaries.sort(byNewest);
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(summaries));
  return summaries;
}

/** Saved rides, newest first. Never throws on bad data; it drops what it cannot read. */
export async function listRides(): Promise<RideSummary[]> {
  return readIndex();
}

/**
 * Saves a ride, then drops the oldest past MAX_RIDES.
 * Returns the ids it evicted so the caller can say so.
 */
export function saveRide(ride: Ride, maxRides: number = MAX_RIDES): Promise<string[]> {
  return serial(async () => {
    const stored: StoredRide = { v: 1, summary: ride.summary, points: ride.points.map(packPoint) };
    // Points first: if the app dies between the two writes, the index rebuild
    // still finds the ride; the reverse order would list a ride with no track.
    await AsyncStorage.setItem(POINTS_PREFIX + ride.summary.id, JSON.stringify(stored));
    const index = (await readIndex()).filter((s) => s.id !== ride.summary.id);
    index.push(ride.summary);
    index.sort(byNewest);
    const keep = index.slice(0, Math.max(1, maxRides));
    const evicted = index.slice(keep.length).map((s) => s.id);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(keep));
    if (evicted.length) await AsyncStorage.multiRemove(evicted.map((id) => POINTS_PREFIX + id));
    return evicted;
  });
}

/** The full ride, or null if it is gone or unreadable. */
export async function loadRide(id: string): Promise<Ride | null> {
  const parsed = parse(await AsyncStorage.getItem(POINTS_PREFIX + id)) as Partial<StoredRide> | null;
  if (!parsed || !isRideSummary(parsed.summary) || !Array.isArray(parsed.points)) return null;
  const points: RidePoint[] = [];
  for (const raw of parsed.points) {
    const p = unpackPoint(raw);
    if (p) points.push(p);
  }
  return { summary: parsed.summary, points };
}

export function deleteRide(id: string): Promise<void> {
  return serial(async () => {
    const index = (await readIndex()).filter((s) => s.id !== id);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index));
    await AsyncStorage.removeItem(POINTS_PREFIX + id);
  });
}
