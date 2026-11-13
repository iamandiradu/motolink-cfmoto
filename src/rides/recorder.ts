/**
 * Ride recorder. Pure: no React, no storage, no clock of its own (callers pass
 * times), so it is fully testable.
 *
 * Product rule: a ride exists only between an explicit start() and stop().
 * Samples outside that window are dropped, never buffered.
 *
 * The totals follow the same honesty rules as TripComputer so the ride log and
 * the Metrics tab never disagree about what "riding" means.
 */
import { haversineM, type MetricsSample } from '../metrics/trip';

/** One stored track point. Kept small: a long ride holds thousands. */
export interface RidePoint {
  /** ms since epoch. */
  t: number;
  lat: number;
  lon: number;
  /** Metres, when the receiver reported altitude. */
  ele?: number;
}

export interface RideSummary {
  id: string;
  /** ms since epoch: when the rider pressed Record. */
  startedAt: number;
  /** ms since epoch: when the rider pressed Stop. */
  endedAt: number;
  distanceM: number;
  /** Time actually riding: moving, with a fresh fix. */
  movingSeconds: number;
  /** Wall time from Record to Stop. */
  totalSeconds: number;
  maxSpeedKmh: number;
  /** Distance over moving time. */
  avgSpeedKmh: number;
  /** Metres climbed, with GPS altitude noise filtered out. 0 without altitude. */
  elevationGainM: number;
  pointCount: number;
}

export interface Ride {
  summary: RideSummary;
  points: RidePoint[];
}

/** What the screen shows while recording. */
export interface LiveRide {
  startedAt: number;
  distanceM: number;
  movingSeconds: number;
  maxSpeedKmh: number;
  pointCount: number;
  /**
   * Auto-pause: the bike has been stopped (below 3 km/h) for longer than the
   * auto-pause threshold. Riding time does not run and no track points are
   * added until it moves again. The ride itself keeps going: only Stop ends it.
   */
  paused: boolean;
}

/** Below this speed the bike counts as stopped (same as TripComputer, src/metrics/trip.ts). */
export const MOVING_THRESHOLD_KMH = 3;
const MOVING_KMH = MOVING_THRESHOLD_KMH;
const MAX_ACCURACY_M = 50;
const MAX_GAP_S = 10;

/** A fix this far before Record was buffered by the receiver; it belongs to before the ride. */
const START_GRACE_MS = 2000;

export interface ThinningOptions {
  /** Keep a point once the bike has moved this far from the last kept one. */
  minDistanceM: number;
  /** Keep a point after this long, if the bike moved at all, so slow sections keep their timing. */
  maxIntervalS: number;
  /** Keep a point on a turn sharper than this, so bends are not cut. */
  headingChangeDeg: number;
  /** Hard cap on stored points; beyond it the track is decimated, not truncated. */
  maxPoints: number;
  /** Stopped for this long (seconds) counts as paused. */
  autoPauseAfterS: number;
}

export const DEFAULT_THINNING: ThinningOptions = {
  minDistanceM: 25,
  maxIntervalS: 30,
  headingChangeDeg: 20,
  // ~60 bytes per point once stored: about 300 KB, well under Android's 2 MB
  // per-row limit in AsyncStorage.
  maxPoints: 5000,
  autoPauseAfterS: 5,
};

/** Below this a "move" is GPS wander, even for the time or heading rules. */
const MIN_MOVE_M = 5;
/** GPS altitude wanders by several metres; only a climb past this counts. */
const ELEVATION_HYSTERESIS_M = 8;

export function newRideId(startedAt: number): string {
  // Start time is unique in practice (one recorder, one rider); the suffix
  // guards against two rides saved in the same millisecond in tests.
  return `${startedAt.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
}

function headingDelta(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

function validSample(s: MetricsSample): boolean {
  return (
    Number.isFinite(s.timestamp) &&
    Number.isFinite(s.latitude) &&
    Number.isFinite(s.longitude) &&
    Math.abs(s.latitude) <= 90 &&
    Math.abs(s.longitude) <= 180 &&
    // Null Island: some receivers report 0,0 before they have a fix.
    !(s.latitude === 0 && s.longitude === 0)
  );
}

export class RideRecorder {
  private readonly opts: ThinningOptions;
  private minDistanceM: number;

  private id: string | null = null;
  private startedAt = 0;
  private points: RidePoint[] = [];
  private distanceM = 0;
  private movingSeconds = 0;
  private maxSpeedKmh = 0;
  private elevationGainM = 0;
  private elevationRef: number | null = null;
  private lastFix: { lat: number; lon: number; at: number } | null = null;
  /** Latest accepted fix that thinning skipped; appended on stop so the track ends where the ride ended. */
  private pending: RidePoint | null = null;
  private lastKeptHeading: number | null = null;
  /** Timestamp of the first stopped fix in the current stop; null while moving. */
  private stoppedSince: number | null = null;
  private paused = false;

  constructor(options: Partial<ThinningOptions> = {}) {
    this.opts = { ...DEFAULT_THINNING, ...options };
    this.minDistanceM = this.opts.minDistanceM;
  }

  isRecording(): boolean {
    return this.id !== null;
  }

  /** Starts a new ride. A second start while recording is ignored, so a double tap cannot wipe a ride. */
  start(now: number, id: string = newRideId(now)): void {
    if (this.id !== null) return;
    this.id = id;
    this.startedAt = now;
    this.points = [];
    this.distanceM = 0;
    this.movingSeconds = 0;
    this.maxSpeedKmh = 0;
    this.elevationGainM = 0;
    this.elevationRef = null;
    this.lastFix = null;
    this.pending = null;
    this.lastKeptHeading = null;
    this.stoppedSince = null;
    this.paused = false;
    this.minDistanceM = this.opts.minDistanceM;
  }

  /** True while auto-paused at a stop. */
  isPaused(): boolean {
    return this.id !== null && this.paused;
  }

  /** Ends the ride and returns it. null when not recording. */
  stop(now: number): Ride | null {
    if (this.id === null) return null;
    if (this.pending) this.points.push(this.pending);
    const endedAt = Math.max(now, this.startedAt);
    const ride: Ride = {
      summary: {
        id: this.id,
        startedAt: this.startedAt,
        endedAt,
        distanceM: this.distanceM,
        movingSeconds: this.movingSeconds,
        totalSeconds: (endedAt - this.startedAt) / 1000,
        maxSpeedKmh: this.maxSpeedKmh,
        avgSpeedKmh: this.movingSeconds > 0 ? this.distanceM / 1000 / (this.movingSeconds / 3600) : 0,
        elevationGainM: this.elevationGainM,
        pointCount: this.points.length,
      },
      points: this.points,
    };
    this.id = null;
    this.points = [];
    this.pending = null;
    this.paused = false;
    this.stoppedSince = null;
    return ride;
  }

  /** Throws the ride away without returning it. */
  discard(): void {
    this.id = null;
    this.points = [];
    this.pending = null;
    this.paused = false;
    this.stoppedSince = null;
  }

  live(): LiveRide | null {
    if (this.id === null) return null;
    return {
      startedAt: this.startedAt,
      distanceM: this.distanceM,
      movingSeconds: this.movingSeconds,
      maxSpeedKmh: this.maxSpeedKmh,
      pointCount: this.points.length + (this.pending ? 1 : 0),
      paused: this.paused,
    };
  }

  /** Folds one GPS sample in. Returns true when it changed the ride. */
  add(sample: MetricsSample): boolean {
    if (this.id === null) return false;
    if (!validSample(sample)) return false;
    if (sample.timestamp < this.startedAt - START_GRACE_MS) return false;
    // Duplicates and out-of-order fixes would add zero or negative time.
    if (this.lastFix && sample.timestamp <= this.lastFix.at) return false;
    // A fix worse than this can be hundreds of metres off; it neither adds
    // distance nor goes on the track. It also does not reset lastFix, so the
    // next good fix measures from the last good one, same as TripComputer.
    if (sample.accuracyM !== undefined && sample.accuracyM > MAX_ACCURACY_M) return false;

    const speed = sample.speedKmh ?? 0;
    const moving = speed >= MOVING_KMH;
    let resumed = false;

    if (this.lastFix) {
      const gap = (sample.timestamp - this.lastFix.at) / 1000;
      if (gap <= MAX_GAP_S && moving) {
        this.distanceM += haversineM(this.lastFix.lat, this.lastFix.lon, sample.latitude, sample.longitude);
        this.movingSeconds += gap;
      }
      resumed = gap > MAX_GAP_S;
    }
    this.lastFix = { lat: sample.latitude, lon: sample.longitude, at: sample.timestamp };
    if (moving) this.maxSpeedKmh = Math.max(this.maxSpeedKmh, speed);
    // Parked altitude drifts; counting it would invent climbs at every coffee stop.
    if (moving && sample.altitudeM !== undefined && Number.isFinite(sample.altitudeM)) this.trackElevation(sample.altitudeM);

    const point: RidePoint = { t: sample.timestamp, lat: sample.latitude, lon: sample.longitude };
    if (sample.altitudeM !== undefined && Number.isFinite(sample.altitudeM)) point.ele = sample.altitudeM;

    // Auto-pause. Stopped time already never counts as riding time (above);
    // past the threshold the ride is also marked paused and stops adding
    // points, so a long coffee stop is not a cloud of GPS wander on the map.
    let resumedFromPause = false;
    if (moving) {
      resumedFromPause = this.paused;
      this.stoppedSince = null;
      this.paused = false;
    } else {
      if (this.stoppedSince === null) this.stoppedSince = sample.timestamp;
      if (!this.paused && sample.timestamp - this.stoppedSince >= this.opts.autoPauseAfterS * 1000) {
        this.paused = true;
        // Pin where the bike stopped, so the track ends at the stop and picks up from it.
        if (this.pending) {
          this.points.push(this.pending);
          this.pending = null;
          if (this.points.length > this.opts.maxPoints) this.decimate();
        } else if (this.points.length === 0) {
          this.points.push(point);
        }
      }
      if (this.paused) return true;
    }

    const heading = moving && sample.headingDeg !== undefined ? sample.headingDeg : null;

    if (this.shouldKeep(point, heading, resumed || resumedFromPause)) {
      this.points.push(point);
      this.pending = null;
      if (heading !== null) this.lastKeptHeading = heading;
      if (this.points.length > this.opts.maxPoints) this.decimate();
    } else {
      this.pending = point;
    }
    return true;
  }

  private shouldKeep(point: RidePoint, heading: number | null, resumed: boolean): boolean {
    const last = this.points[this.points.length - 1];
    if (!last) return true;
    // Mark where the track picks up again after a tunnel or a suspended app,
    // and keep the fix before the gap so the segment does not cut a corner.
    if (resumed) {
      if (this.pending) this.points.push(this.pending);
      return true;
    }
    const d = haversineM(last.lat, last.lon, point.lat, point.lon);
    if (d >= this.minDistanceM) return true;
    if (d < MIN_MOVE_M) return false;
    if ((point.t - last.t) / 1000 >= this.opts.maxIntervalS) return true;
    if (heading !== null && this.lastKeptHeading !== null) {
      return headingDelta(heading, this.lastKeptHeading) >= this.opts.headingChangeDeg;
    }
    return false;
  }

  /**
   * Over the cap: drop every other point and keep future points twice as far
   * apart. The whole ride keeps its shape at lower detail, instead of the end
   * of a long ride being cut off.
   */
  private decimate(): void {
    const last = this.points[this.points.length - 1];
    const kept = this.points.filter((_, i) => i % 2 === 0);
    if (kept[kept.length - 1] !== last) kept.push(last);
    this.points = kept;
    this.minDistanceM *= 2;
  }

  /** Hysteresis filter: count a climb only once altitude has risen clearly above the last low. */
  private trackElevation(alt: number): void {
    if (this.elevationRef === null) {
      this.elevationRef = alt;
      return;
    }
    if (alt >= this.elevationRef + ELEVATION_HYSTERESIS_M) {
      this.elevationGainM += alt - this.elevationRef;
      this.elevationRef = alt;
    } else if (alt <= this.elevationRef - ELEVATION_HYSTERESIS_M) {
      this.elevationRef = alt;
    }
  }
}
