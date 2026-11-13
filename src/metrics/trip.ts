/**
 * Ride metrics.
 *
 * The dash link carries no vehicle data: no speed, rpm, gear or fuel reaches
 * the phone over Wi-Fi or Bluetooth on a bike without the T-Box. So metrics
 * come from sources that implement MetricsSource. The phone's own sensors are
 * the first one; an OBD-II adapter on the diagnostic plug can be added as
 * another without touching the consumers.
 */

export interface Metrics {
  /** km/h. null until a source reports it. */
  speedKmh: number | null;
  /** Degrees clockwise from north. */
  headingDeg: number | null;
  altitudeM: number | null;
  /** Degrees, positive leaning right. */
  leanDeg: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Engine data. Only an OBD-II source can fill these. */
  rpm: number | null;
  coolantC: number | null;
  batteryV: number | null;
  /** Trip computer. */
  tripKm: number;
  movingSeconds: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  maxLeanDeg: number;
}

export const EMPTY_METRICS: Metrics = {
  speedKmh: null,
  headingDeg: null,
  altitudeM: null,
  leanDeg: null,
  latitude: null,
  longitude: null,
  rpm: null,
  coolantC: null,
  batteryV: null,
  tripKm: 0,
  movingSeconds: 0,
  maxSpeedKmh: 0,
  avgSpeedKmh: 0,
  maxLeanDeg: 0,
};

/** A partial reading from one source. Fields left out keep their last value. */
export type MetricsSample = Partial<
  Pick<
    Metrics,
    | 'speedKmh'
    | 'headingDeg'
    | 'altitudeM'
    | 'leanDeg'
    | 'latitude'
    | 'longitude'
    | 'rpm'
    | 'coolantC'
    | 'batteryV'
  >
> & {
  /** ms since epoch. */
  timestamp: number;
  /** Position accuracy in metres, when the sample carries a position. */
  accuracyM?: number;
};

export interface MetricsSource {
  readonly id: string;
  start(emit: (sample: MetricsSample) => void): Promise<void>;
  stop(): void;
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

/** Folds samples into the current metrics and the trip totals. */
export class TripComputer {
  private metrics: Metrics = { ...EMPTY_METRICS };
  private lastFix: { lat: number; lon: number; at: number } | null = null;

  get(): Metrics {
    return this.metrics;
  }

  resetTrip(): Metrics {
    this.metrics = {
      ...this.metrics,
      tripKm: 0,
      movingSeconds: 0,
      maxSpeedKmh: 0,
      avgSpeedKmh: 0,
      maxLeanDeg: 0,
    };
    this.lastFix = null;
    return this.metrics;
  }

  add(sample: MetricsSample): Metrics {
    const next: Metrics = { ...this.metrics };
    for (const key of [
      'speedKmh',
      'headingDeg',
      'altitudeM',
      'leanDeg',
      'latitude',
      'longitude',
      'rpm',
      'coolantC',
      'batteryV',
    ] as const) {
      const value = sample[key];
      if (value !== undefined) next[key] = value;
    }

    if (typeof sample.leanDeg === 'number') {
      next.maxLeanDeg = Math.max(next.maxLeanDeg, Math.abs(sample.leanDeg));
    }

    const hasFix = typeof sample.latitude === 'number' && typeof sample.longitude === 'number';
    if (hasFix) {
      const accurate = sample.accuracyM === undefined || sample.accuracyM <= MAX_ACCURACY_M;
      const speed = typeof sample.speedKmh === 'number' ? sample.speedKmh : 0;
      if (this.lastFix && accurate) {
        const gap = (sample.timestamp - this.lastFix.at) / 1000;
        if (gap > 0 && gap <= MAX_GAP_S && speed >= MOVING_KMH) {
          next.tripKm +=
            haversineM(this.lastFix.lat, this.lastFix.lon, sample.latitude!, sample.longitude!) / 1000;
          next.movingSeconds += gap;
        }
      }
      if (accurate) {
        this.lastFix = { lat: sample.latitude!, lon: sample.longitude!, at: sample.timestamp };
        next.maxSpeedKmh = Math.max(next.maxSpeedKmh, speed);
      }
      next.avgSpeedKmh = next.movingSeconds > 0 ? next.tripKm / (next.movingSeconds / 3600) : 0;
    }

    this.metrics = next;
    return next;
  }
}
