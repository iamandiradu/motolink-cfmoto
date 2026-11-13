/**
 * Lean angle estimate.
 *
 * Nothing on the bike reports lean, and the phone may be in a pocket at any
 * angle, so lean cannot be read off the phone's tilt. Worse, in a steady turn
 * the accelerometer of a leaning bike still reads "straight down" along the
 * bike, because gravity and the cornering force combine along it.
 *
 * What does work in any phone position is physics: a bike holding a turn must
 * lean so that tan(lean) = speed x turn rate / g. Speed comes from GPS. Turn
 * rate comes from two places:
 *
 *   - the motion sensors: the gyroscope's rotation, taken around the direction
 *     the accelerometer says is down. Fast (many readings a second) and the
 *     same whichever way the phone lies. It gives how hard the bike turns.
 *   - GPS course: how the direction of travel changes. Slow (once a second,
 *     lagging) but it knows left from right for certain.
 *
 * So the size of the lean comes from the motion sensors when they are
 * available, and its side from GPS. Without motion sensors it falls back to
 * GPS alone. Either way this is an estimate, not a measurement.
 */

export interface MotionSample {
  /** ms since epoch. */
  timestamp: number;
  /** Rotation rate around the phone's x, y, z axes, degrees per second. */
  rotationRate: { x: number; y: number; z: number };
  /** Acceleration including gravity along the phone's axes, any consistent unit. */
  gravity: { x: number; y: number; z: number };
}

/** Below this GPS course is noise and a bike barely leans anyway. */
export const LEAN_MIN_KMH = 15;
/** Estimates above this are glitches, not riding. */
const LEAN_MAX_DEG = 60;
const GRAVITY = 9.81;
/** Motion readings older than this are not trusted; fall back to GPS. */
const MOTION_FRESH_MS = 600;
/** Share of each new motion reading blended in (about half a second of smoothing at 10 Hz). */
const MOTION_SMOOTHING = 0.25;
/** Share of each new GPS-only estimate blended in. */
const GPS_SMOOTHING = 0.6;
/** A GPS turn smaller than this (deg/s) does not say which side reliably. */
const SIDE_MIN_TURN = 2;

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Lean needed to hold a turn at this speed and turn rate. Positive turn rate is to the right. */
export function leanForTurn(speedKmh: number, turnRateDegPerSec: number): number | null {
  if (speedKmh < LEAN_MIN_KMH) return null;
  const lean = deg(Math.atan(((speedKmh / 3.6) * rad(turnRateDegPerSec)) / GRAVITY));
  return Math.abs(lean) > LEAN_MAX_DEG ? null : lean;
}

/**
 * Lean from two GPS courses. Speed in km/h, headings in degrees, dt in seconds.
 * Positive leans right.
 */
export function estimateLeanDeg(
  speedKmh: number,
  fromHeadingDeg: number,
  toHeadingDeg: number,
  dtSeconds: number,
): number | null {
  if (dtSeconds <= 0 || dtSeconds > 3) return null;
  // Shortest way round, so 350 -> 10 is +20 degrees, not -340.
  const turn = ((toHeadingDeg - fromHeadingDeg + 540) % 360) - 180;
  return leanForTurn(speedKmh, turn / dtSeconds);
}

/**
 * How fast the phone turns around the vertical, in degrees per second, from
 * the gyroscope and the accelerometer's sense of down. The sign depends on how
 * the phone lies, so only the size is used. null when "down" is unclear.
 */
export function turnRateAroundVertical(sample: MotionSample): number | null {
  const { gravity: g, rotationRate: r } = sample;
  const length = Math.hypot(g.x, g.y, g.z);
  if (!(length > 0)) return null;
  return Math.abs((r.x * g.x + r.y * g.y + r.z * g.z) / length);
}

export class LeanEstimator {
  private speedKmh = 0;
  private lastCourse: { heading: number; at: number } | null = null;
  /** +1 right, -1 left, from the last clear GPS turn. */
  private side = 0;
  private lastGpsLean: number | null = null;
  private motionRate: number | null = null;
  private lastMotionAt = 0;
  private lean: number | null = null;

  get(): number | null {
    return this.lean;
  }

  reset(): void {
    this.lastCourse = null;
    this.side = 0;
    this.lastGpsLean = null;
    this.motionRate = null;
    this.lean = null;
  }

  /** A GPS reading. `headingDeg` undefined means the receiver gave no course. */
  gps(timestamp: number, speedKmh: number | undefined, headingDeg: number | undefined): number | null {
    this.speedKmh = speedKmh ?? 0;
    if (this.speedKmh < LEAN_MIN_KMH || headingDeg === undefined) {
      // Too slow to lean, or no course: upright, and start fresh next time.
      this.lastCourse = null;
      this.side = 0;
      this.lastGpsLean = null;
      this.lean = speedKmh === undefined ? this.lean : 0;
      return this.lean;
    }

    if (this.lastCourse) {
      const dt = (timestamp - this.lastCourse.at) / 1000;
      const estimate = estimateLeanDeg(this.speedKmh, this.lastCourse.heading, headingDeg, dt);
      if (estimate !== null) {
        this.lastGpsLean = estimate;
        const turn = (((headingDeg - this.lastCourse.heading + 540) % 360) - 180) / dt;
        if (Math.abs(turn) >= SIDE_MIN_TURN) this.side = Math.sign(turn);
        else if (Math.abs(turn) < SIDE_MIN_TURN / 2) this.side = 0;
        // Without fresh motion data, GPS is all there is.
        if (!this.motionFresh(timestamp)) {
          const previous = this.lean ?? estimate;
          this.lean = previous + (estimate - previous) * GPS_SMOOTHING;
        }
      }
    }
    this.lastCourse = { heading: headingDeg, at: timestamp };
    return this.lean;
  }

  /** A motion-sensor reading. Refines the size of the lean between GPS fixes. */
  motion(sample: MotionSample): number | null {
    const rate = turnRateAroundVertical(sample);
    if (rate === null) return this.lean;
    this.lastMotionAt = sample.timestamp;
    this.motionRate = this.motionRate === null ? rate : this.motionRate + (rate - this.motionRate) * MOTION_SMOOTHING;

    if (this.speedKmh < LEAN_MIN_KMH) {
      this.lean = 0;
      return this.lean;
    }
    const size = leanForTurn(this.speedKmh, this.motionRate);
    if (size === null) return this.lean;
    // Side unknown yet (GPS has not seen the turn): hold the previous side rather than guess.
    const side = this.side !== 0 ? this.side : Math.sign(this.lean ?? 0);
    this.lean = side === 0 ? 0 : side * Math.abs(size);
    return this.lean;
  }

  private motionFresh(now: number): boolean {
    return this.motionRate !== null && now - this.lastMotionAt < MOTION_FRESH_MS;
  }
}
