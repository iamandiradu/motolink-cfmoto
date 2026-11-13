/**
 * Ride metrics.
 *
 * The dash link carries no vehicle data: no speed, rpm, gear or fuel reaches
 * the phone over Wi-Fi or Bluetooth on a bike without the T-Box. So everything
 * here comes from the phone's GPS. Only values that hold up with the phone in
 * a pocket are kept: lean angle, for one, needs a rigidly mounted phone and
 * was dropped.
 *
 * MetricsSource is the seam for another source later (an OBD-II adapter).
 */

export interface Metrics {
  /** km/h. null until the first GPS fix. */
  speedKmh: number | null;
  /** Direction of travel, degrees clockwise from north. Held while stopped. */
  headingDeg: number | null;
  altitudeM: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Position accuracy in metres; lower is better. null without a fix. */
  accuracyM: number | null;
  /** Trip computer. */
  tripKm: number;
  movingSeconds: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
}

export const EMPTY_METRICS: Metrics = {
  speedKmh: null,
  headingDeg: null,
  altitudeM: null,
  latitude: null,
  longitude: null,
  accuracyM: null,
  tripKm: 0,
  movingSeconds: 0,
  maxSpeedKmh: 0,
  avgSpeedKmh: 0,
};

/** One GPS reading. */
export interface MetricsSample {
  /** ms since epoch. */
  timestamp: number;
  latitude: number;
  longitude: number;
  /** km/h, when the receiver reports it. */
  speedKmh?: number;
  /** Course over ground, degrees. */
  headingDeg?: number;
  altitudeM?: number;
  accuracyM?: number;
}

export interface MetricsSource {
  readonly id: string;
  start(emit: (sample: MetricsSample) => void): Promise<void>;
  stop(): void;
}

export type GpsQuality = 'none' | 'poor' | 'good';

export function gpsQuality(accuracyM: number | null): GpsQuality {
  if (accuracyM === null) return 'none';
  return accuracyM <= 20 ? 'good' : 'poor';
}

const EARTH_RADIUS_M = 6_371_000;
/** Below this the bike counts as stopped; GPS speed jitters around zero. */
const MOVING_KMH = 3;
/** A position worse than this does not add distance. */
const MAX_ACCURACY_M = 50;
/** A gap longer than this (tunnel, app suspended) does not count as riding time. */
const MAX_GAP_S = 10;

const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function compassPoint(headingDeg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round((((headingDeg % 360) + 360) % 360) / 45) % 8];
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 24-hour clock, HH:MM. */
export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Folds GPS samples into the current metrics and the trip totals. */
export class TripComputer {
  private metrics: Metrics = { ...EMPTY_METRICS };
  private lastFix: { lat: number; lon: number; at: number } | null = null;

  get(): Metrics {
    return this.metrics;
  }

  resetTrip(): Metrics {
    this.metrics = { ...this.metrics, tripKm: 0, movingSeconds: 0, maxSpeedKmh: 0, avgSpeedKmh: 0 };
    this.lastFix = null;
    return this.metrics;
  }

  add(sample: MetricsSample): Metrics {
    const next: Metrics = { ...this.metrics };
    const accurate = sample.accuracyM === undefined || sample.accuracyM <= MAX_ACCURACY_M;
    const rawSpeed = sample.speedKmh ?? 0;
    const moving = rawSpeed >= MOVING_KMH;

    next.latitude = sample.latitude;
    next.longitude = sample.longitude;
    next.accuracyM = sample.accuracyM ?? null;
    if (sample.altitudeM !== undefined) next.altitudeM = sample.altitudeM;
    // A parked bike reads 0, not the 1-2 km/h a stationary GPS wanders by.
    if (sample.speedKmh !== undefined) next.speedKmh = moving ? rawSpeed : 0;
    // Course is noise while stopped; keep the last direction of travel.
    if (sample.headingDeg !== undefined && moving) next.headingDeg = sample.headingDeg;

    if (accurate) {
      if (this.lastFix) {
        const gap = (sample.timestamp - this.lastFix.at) / 1000;
        if (gap > 0 && gap <= MAX_GAP_S && moving) {
          next.tripKm += haversineM(this.lastFix.lat, this.lastFix.lon, sample.latitude, sample.longitude) / 1000;
          next.movingSeconds += gap;
        }
      }
      this.lastFix = { lat: sample.latitude, lon: sample.longitude, at: sample.timestamp };
      if (moving) next.maxSpeedKmh = Math.max(next.maxSpeedKmh, rawSpeed);
      next.avgSpeedKmh = next.movingSeconds > 0 ? next.tripKm / (next.movingSeconds / 3600) : 0;
    }

    this.metrics = next;
    return next;
  }
}
