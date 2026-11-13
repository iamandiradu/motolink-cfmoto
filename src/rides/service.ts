/**
 * Service reminders. Pure: no React, no storage.
 *
 * Every item counts the kilometres since it was last done. Distance comes in
 * three ways: recorded rides (added when a ride is saved), distance the rider
 * adds by hand for rides not recorded, and setting the bike's odometer (the
 * increase since the last reading is counted as ridden).
 *
 * The default intervals are generic guesses for a chain-drive motorcycle,
 * not CFMOTO's schedule. The screen says so.
 */

export interface ServiceItem {
  id: string;
  name: string;
  /** Every this many km. */
  intervalKm: number;
  /** Km ridden since it was last done. */
  kmSinceDone: number;
}

export interface ServiceState {
  v: 1;
  items: ServiceItem[];
  /** Last odometer reading the rider entered plus distance counted since; null until entered once. */
  odometerKm: number | null;
  /** Rides already counted, newest last, so a ride is never added twice. */
  countedRideIds: string[];
}

export type ServiceStatus = 'ok' | 'soon' | 'due';

export interface ServiceItemStatus extends ServiceItem {
  status: ServiceStatus;
  /** kmSinceDone / intervalKm; 1 or more is due. */
  fraction: number;
  /** Km left before it is due; negative when overdue. */
  remainingKm: number;
}

/** "Soon" from this share of the interval. */
export const SOON_FRACTION = 0.85;
export const MIN_INTERVAL_KM = 100;
export const MAX_INTERVAL_KM = 100_000;
/** One manual entry above this is almost certainly a typo. */
export const MAX_MANUAL_KM = 20_000;
const MAX_COUNTED_IDS = 200;

export const DEFAULT_SERVICE_ITEMS: readonly ServiceItem[] = [
  { id: 'chain-lube', name: 'Chain lube', intervalKm: 500, kmSinceDone: 0 },
  { id: 'chain-adjust', name: 'Chain adjustment', intervalKm: 1000, kmSinceDone: 0 },
  { id: 'oil', name: 'Engine oil and filter', intervalKm: 6000, kmSinceDone: 0 },
];

export function defaultServiceState(): ServiceState {
  return { v: 1, items: DEFAULT_SERVICE_ITEMS.map((i) => ({ ...i })), odometerKm: null, countedRideIds: [] };
}

const validKm = (km: number) => Number.isFinite(km) && km > 0;

function addToItems(items: ServiceItem[], km: number): ServiceItem[] {
  return items.map((i) => ({ ...i, kmSinceDone: i.kmSinceDone + km }));
}

/** Adds ridden distance to every item (and the odometer, once it is known). */
export function addDistance(state: ServiceState, km: number): ServiceState {
  if (!validKm(km) || km > MAX_MANUAL_KM) return state;
  return {
    ...state,
    items: addToItems(state.items, km),
    odometerKm: state.odometerKm === null ? null : state.odometerKm + km,
  };
}

/** Adds a saved ride's distance once; a second call with the same id does nothing. */
export function addRide(state: ServiceState, rideId: string, distanceM: number): ServiceState {
  if (state.countedRideIds.includes(rideId)) return state;
  const km = distanceM / 1000;
  const next = validKm(km) ? addDistance(state, km) : state;
  return { ...next, countedRideIds: [...state.countedRideIds, rideId].slice(-MAX_COUNTED_IDS) };
}

/**
 * Sets the bike's odometer. The first reading only sets the baseline. After
 * that, an increase is distance ridden and is added to every item; a lower
 * reading is taken as a correction and changes no item.
 */
export function setOdometer(state: ServiceState, km: number): ServiceState {
  if (!Number.isFinite(km) || km < 0) return state;
  const value = Math.round(km);
  if (state.odometerKm === null || value <= state.odometerKm) return { ...state, odometerKm: value };
  const delta = value - state.odometerKm;
  return { ...state, odometerKm: value, items: addToItems(state.items, delta) };
}

/** Marks one item done now. */
export function markDone(state: ServiceState, id: string): ServiceState {
  return { ...state, items: state.items.map((i) => (i.id === id ? { ...i, kmSinceDone: 0 } : i)) };
}

/** Changes how often an item is due, clamped to a sensible range. */
export function setServiceInterval(state: ServiceState, id: string, intervalKm: number): ServiceState {
  if (!Number.isFinite(intervalKm)) return state;
  const value = Math.min(MAX_INTERVAL_KM, Math.max(MIN_INTERVAL_KM, Math.round(intervalKm)));
  return { ...state, items: state.items.map((i) => (i.id === id ? { ...i, intervalKm: value } : i)) };
}

export function statusOf(item: ServiceItem): ServiceItemStatus {
  const fraction = item.intervalKm > 0 ? item.kmSinceDone / item.intervalKm : 1;
  const status: ServiceStatus = fraction >= 1 ? 'due' : fraction >= SOON_FRACTION ? 'soon' : 'ok';
  return { ...item, status, fraction, remainingKm: item.intervalKm - item.kmSinceDone };
}

/** Every item with its status, in the stored order. */
export function serviceStatuses(state: ServiceState): ServiceItemStatus[] {
  return state.items.map(statusOf);
}

/** Every item with its status, most urgent first (due, then soon, then ok). */
export function dueItems(state: ServiceState): ServiceItemStatus[] {
  return serviceStatuses(state).sort((a, b) => b.fraction - a.fraction);
}

/** Reads a stored value, keeping what is valid and falling back to defaults. */
export function parseServiceState(value: unknown): ServiceState {
  const fallback = defaultServiceState();
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Record<string, unknown>;
  const items: ServiceItem[] = [];
  if (Array.isArray(v.items)) {
    for (const raw of v.items) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
      if (typeof r.intervalKm !== 'number' || !Number.isFinite(r.intervalKm) || r.intervalKm <= 0) continue;
      if (typeof r.kmSinceDone !== 'number' || !Number.isFinite(r.kmSinceDone) || r.kmSinceDone < 0) continue;
      if (items.some((i) => i.id === r.id)) continue;
      items.push({ id: r.id, name: r.name, intervalKm: r.intervalKm, kmSinceDone: r.kmSinceDone });
    }
  }
  const odometerKm = typeof v.odometerKm === 'number' && Number.isFinite(v.odometerKm) && v.odometerKm >= 0 ? v.odometerKm : null;
  const countedRideIds = Array.isArray(v.countedRideIds) ? v.countedRideIds.filter((x): x is string => typeof x === 'string') : [];
  return { v: 1, items: items.length ? items : fallback.items, odometerKm, countedRideIds };
}
