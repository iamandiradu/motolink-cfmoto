/**
 * Fuel reminder bookkeeping. The bike sends no fuel level, so the reminder
 * counts kilometres since the rider last said they refuelled. Pure: takes and
 * returns plain state; the caller stores it.
 */

export interface FuelState {
  kmSinceRefuel: number;
  /** Last trip-meter reading seen, to turn the trip meter into deltas. */
  lastTripKm: number | null;
}

export const EMPTY_FUEL: FuelState = { kmSinceRefuel: 0, lastTripKm: null };

/** A single GPS jump larger than this is ignored. */
const MAX_STEP_KM = 50;

export function addDistance(state: FuelState, km: number): FuelState {
  if (!Number.isFinite(km) || km <= 0 || km > MAX_STEP_KM) return state;
  return { ...state, kmSinceRefuel: state.kmSinceRefuel + km };
}

/**
 * Feed the trip meter (Metrics.tripKm). Adds what was ridden since the last
 * reading; a trip reset (the meter going down) adds nothing and re-anchors.
 */
export function trackTrip(state: FuelState, tripKm: number): FuelState {
  if (!Number.isFinite(tripKm) || tripKm < 0) return state;
  if (state.lastTripKm === null || tripKm < state.lastTripKm) return { ...state, lastTripKm: tripKm };
  if (tripKm === state.lastTripKm) return state;
  return { ...addDistance(state, tripKm - state.lastTripKm), lastTripKm: tripKm };
}

/** The rider filled up. Keeps the trip anchor so the next reading counts from here. */
export function refuel(state: FuelState): FuelState {
  return { ...state, kmSinceRefuel: 0 };
}

/** Kilometres left before the set range is used up; never below 0. null when off. */
export function remainingKm(state: FuelState, rangeKm: number | null): number | null {
  if (rangeKm === null || rangeKm <= 0) return null;
  return Math.max(0, rangeKm - state.kmSinceRefuel);
}

/** Share of the range used, 0..100 and beyond. null when off. */
export function percentUsed(state: FuelState, rangeKm: number | null): number | null {
  if (rangeKm === null || rangeKm <= 0) return null;
  return (state.kmSinceRefuel / rangeKm) * 100;
}
