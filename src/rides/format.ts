/** Unit formatting shared by the ride screens. */
import { t } from '../i18n';

export const KM_TO_MI = 0.621371;

const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;

/** Short month name (0-11) in the current language. */
export function monthShort(month: number): string {
  return t(`months.${MONTH_KEYS[((month % 12) + 12) % 12]}`);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * "13 Nov 2026 09:30" in the current language, for titles on screen. The GPX
 * file keeps defaultRideName (English) so exported names stay stable.
 */
export function rideDate(startedAt: number): string {
  const d = new Date(startedAt);
  return `${d.getDate()} ${monthShort(d.getMonth())} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Ride 13 Nov 2026 09:30" in the current language, for accessibility labels and dialogs. */
export function rideName(startedAt: number): string {
  return t('rides.rideName', { date: rideDate(startedAt) });
}

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
