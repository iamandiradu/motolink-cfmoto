/**
 * Persistence for learned bikes and imported profiles. Kept apart from the
 * pure logic so that logic runs under Jest without a storage mock.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { LearnedBike, mergeLearned, normaliseLearned } from './learned';
import { BikeProfile } from './profiles';
import { parseProfileJson } from './share';

const KEYS = { learned: 'bikes.learned.v1', custom: 'bikes.customProfiles.v1' } as const;

async function readJson(key: string): Promise<unknown> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Writes run one after another: the session reports often, and two
 * overlapping read-modify-write cycles would drop one of the updates.
 */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

export async function loadLearnedBikes(): Promise<Record<string, LearnedBike>> {
  const stored = await readJson(KEYS.learned);
  const out: Record<string, LearnedBike> = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const value of Object.values(stored as Record<string, unknown>)) {
      const bike = normaliseLearned(value);
      if (bike) out[bike.ssid] = out[bike.ssid] ? mergeLearned(out[bike.ssid], bike) : bike;
    }
  }
  return out;
}

export async function loadLearnedBike(ssid: string): Promise<LearnedBike | null> {
  return (await loadLearnedBikes())[ssid] ?? null;
}

/** Stores the record as given; it replaces the stored one for that SSID. */
export function saveLearnedBike(bike: LearnedBike): Promise<void> {
  return serial(async () => {
    const all = await loadLearnedBikes();
    all[bike.ssid] = bike;
    await AsyncStorage.setItem(KEYS.learned, JSON.stringify(all));
  });
}

export function forgetLearnedBike(ssid: string): Promise<void> {
  return serial(async () => {
    const all = await loadLearnedBikes();
    if (!(ssid in all)) return;
    delete all[ssid];
    await AsyncStorage.setItem(KEYS.learned, JSON.stringify(all));
  });
}

/** Imported profiles. Each is validated again on load, as a stored value may come from an older app. */
export async function loadCustomProfiles(): Promise<BikeProfile[]> {
  const stored = await readJson(KEYS.custom);
  if (!Array.isArray(stored)) return [];
  const out: BikeProfile[] = [];
  for (const item of stored) {
    const result = parseProfileJson(JSON.stringify(item));
    if (result.ok && !out.some((p) => p.id === result.profile.id)) out.push(result.profile);
  }
  return out;
}

/** Adds or replaces (same id) an imported profile. */
export function saveCustomProfile(profile: BikeProfile): Promise<void> {
  return serial(async () => {
    const list = (await loadCustomProfiles()).filter((p) => p.id !== profile.id);
    await AsyncStorage.setItem(KEYS.custom, JSON.stringify([...list, profile]));
  });
}

export function removeCustomProfile(id: string): Promise<void> {
  return serial(async () => {
    const list = await loadCustomProfiles();
    await AsyncStorage.setItem(KEYS.custom, JSON.stringify(list.filter((p) => p.id !== id)));
  });
}
