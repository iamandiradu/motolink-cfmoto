/** Unit formatting shared by the ride screens. */
export const KM_TO_MI = 0.621371;

export interface Units {
  imperial: boolean;
}

export function formatDistance(m: number, imperial: boolean, digits = 1): string {
  const km = m / 1000;
  return `${(imperial ? km * KM_TO_MI : km).toFixed(digits)} ${imperial ? 'mi' : 'km'}`;
}

export function formatSpeed(kmh: number, imperial: boolean): string {
  return `${Math.round(imperial ? kmh * KM_TO_MI : kmh)} ${imperial ? 'mph' : 'km/h'}`;
}

export function formatClimb(m: number, imperial: boolean): string {
  return imperial ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`;
}

/** Km as a whole number in the rider's unit, e.g. "1,250 km". */
export function formatKm(km: number, imperial: boolean): string {
  const v = Math.round(imperial ? km * KM_TO_MI : km);
  return `${v.toLocaleString('en-US')} ${imperial ? 'mi' : 'km'}`;
}

/** Hours and minutes for long totals, e.g. "12 h 05 min". */
export function formatHours(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
