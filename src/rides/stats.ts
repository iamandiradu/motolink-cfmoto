/**
 * Lifetime statistics over the saved rides. Pure.
 *
 * Months are the rider's local calendar months (a ride at 00:30 on 1 March
 * belongs to March where the rider is). Bucketing uses the local Date fields
 * only, never fixed offsets, so it is right in every time zone and across DST.
 */
import type { RideSummary } from './recorder';

export interface RideTotals {
  rides: number;
  distanceM: number;
  movingSeconds: number;
  /** The ride with the greatest distance; null with no rides. */
  longest: RideSummary | null;
  topSpeedKmh: number;
  climbM: number;
}

export interface MonthBucket {
  /** "YYYY-MM", local calendar. */
  key: string;
  year: number;
  /** 0-11. */
  month: number;
  /** Short English month name, e.g. "Nov". */
  label: string;
  rides: number;
  distanceM: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const finite = (v: number) => (Number.isFinite(v) ? v : 0);

export function rideTotals(rides: readonly RideSummary[]): RideTotals {
  let longest: RideSummary | null = null;
  const totals: RideTotals = { rides: 0, distanceM: 0, movingSeconds: 0, longest: null, topSpeedKmh: 0, climbM: 0 };
  for (const r of rides) {
    totals.rides += 1;
    totals.distanceM += finite(r.distanceM);
    totals.movingSeconds += finite(r.movingSeconds);
    totals.topSpeedKmh = Math.max(totals.topSpeedKmh, finite(r.maxSpeedKmh));
    totals.climbM += finite(r.elevationGainM);
    if (!longest || r.distanceM > longest.distanceM) longest = r;
  }
  totals.longest = longest;
  return totals;
}

const monthKey = (year: number, month: number) => `${year}-${String(month + 1).padStart(2, '0')}`;

/**
 * The last `count` calendar months, oldest first, ending with the month of
 * `now`. Every month is present, with zero for months without rides. Rides are
 * placed by their start time.
 */
export function monthlyBuckets(rides: readonly RideSummary[], now: number = Date.now(), count = 12): MonthBucket[] {
  const today = new Date(now);
  const buckets: MonthBucket[] = [];
  const byKey = new Map<string, MonthBucket>();
  for (let i = count - 1; i >= 0; i--) {
    // Day 1 at noon: month arithmetic on the 1st never overflows, and noon is clear of DST jumps.
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1, 12);
    const bucket: MonthBucket = {
      key: monthKey(d.getFullYear(), d.getMonth()),
      year: d.getFullYear(),
      month: d.getMonth(),
      label: MONTHS[d.getMonth()],
      rides: 0,
      distanceM: 0,
    };
    buckets.push(bucket);
    byKey.set(bucket.key, bucket);
  }
  for (const r of rides) {
    if (!Number.isFinite(r.startedAt)) continue;
    const d = new Date(r.startedAt);
    const bucket = byKey.get(monthKey(d.getFullYear(), d.getMonth()));
    if (!bucket) continue;
    bucket.rides += 1;
    bucket.distanceM += finite(r.distanceM);
  }
  return buckets;
}

export interface RideStats {
  totals: RideTotals;
  months: MonthBucket[];
}

export function rideStats(rides: readonly RideSummary[], now: number = Date.now()): RideStats {
  return { totals: rideTotals(rides), months: monthlyBuckets(rides, now) };
}
