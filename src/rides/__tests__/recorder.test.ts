import { haversineM, type MetricsSample } from '../../metrics/trip';
import { RideRecorder } from '../recorder';

const T0 = Date.UTC(2026, 10, 13, 8, 0, 0);
/** ~11.1 m per 0.0001 deg of latitude. */
const DLAT = 0.0001;

/** A straight ride north, one fix a second. */
function northTrack(n: number, opts: Partial<MetricsSample> = {}, start = T0, lat0 = 45): MetricsSample[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: start + i * 1000,
    latitude: lat0 + i * DLAT,
    longitude: 7,
    speedKmh: 40,
    headingDeg: 0,
    accuracyM: 5,
    ...opts,
  }));
}

describe('RideRecorder', () => {
  it('ignores samples while not recording', () => {
    const r = new RideRecorder();
    for (const s of northTrack(10)) expect(r.add(s)).toBe(false);
    expect(r.live()).toBeNull();
    expect(r.stop(T0 + 10_000)).toBeNull();
  });

  it('measures distance on a known track', () => {
    const r = new RideRecorder();
    r.start(T0);
    const track = northTrack(101);
    track.forEach((s) => r.add(s));
    const ride = r.stop(T0 + 100_000)!;
    const expected = haversineM(45, 7, 45 + 100 * DLAT, 7);
    expect(ride.summary.distanceM).toBeCloseTo(expected, 0);
    expect(ride.summary.movingSeconds).toBe(100);
    expect(ride.summary.totalSeconds).toBe(100);
    expect(ride.summary.maxSpeedKmh).toBe(40);
    expect(ride.summary.avgSpeedKmh).toBeCloseTo((expected / 1000) / (100 / 3600), 3);
    expect(ride.summary.startedAt).toBe(T0);
  });

  it('excludes stopped time and gaps from riding time', () => {
    const r = new RideRecorder();
    r.start(T0);
    northTrack(11).forEach((s) => r.add(s)); // 10 s riding
    const at = 45 + 10 * DLAT;
    // 60 s parked: speed 0, GPS wandering a few metres.
    for (let i = 1; i <= 60; i++) {
      r.add({ timestamp: T0 + 10_000 + i * 1000, latitude: at + (i % 2) * 0.00002, longitude: 7, speedKmh: 0.8, accuracyM: 5 });
    }
    // Tunnel: 30 s with no fix, then 10 more seconds of riding.
    const resume = T0 + 100_000;
    northTrack(11, {}, resume, at + 0.01).forEach((s) => r.add(s));
    const ride = r.stop(resume + 10_000)!;
    expect(ride.summary.movingSeconds).toBe(20);
    expect(ride.summary.totalSeconds).toBe(110);
    // The jump across the tunnel (~1.1 km) is not counted.
    expect(ride.summary.distanceM).toBeLessThan(250);
  });

  it('ignores bad fixes', () => {
    const r = new RideRecorder();
    r.start(T0);
    r.add({ timestamp: T0, latitude: 45, longitude: 7, speedKmh: 40, accuracyM: 5 });
    // 500 m off with poor accuracy: must not add distance or a point.
    expect(r.add({ timestamp: T0 + 1000, latitude: 45.0045, longitude: 7, speedKmh: 40, accuracyM: 120 })).toBe(false);
    expect(r.add({ timestamp: T0 + 1500, latitude: NaN, longitude: 7, speedKmh: 40 })).toBe(false);
    expect(r.add({ timestamp: T0 + 1600, latitude: 0, longitude: 0, speedKmh: 40 })).toBe(false);
    // Stale fix from before Record.
    expect(r.add({ timestamp: T0 - 60_000, latitude: 45, longitude: 7, speedKmh: 40 })).toBe(false);
    r.add({ timestamp: T0 + 2000, latitude: 45 + DLAT, longitude: 7, speedKmh: 40, accuracyM: 5 });
    const ride = r.stop(T0 + 2000)!;
    expect(ride.summary.distanceM).toBeCloseTo(haversineM(45, 7, 45 + DLAT, 7), 3);
    expect(ride.points.every((p) => p.lat < 45.001)).toBe(true);
  });

  it('adds no distance below 3 km/h', () => {
    const r = new RideRecorder();
    r.start(T0);
    northTrack(20, { speedKmh: 2 }).forEach((s) => r.add(s));
    const ride = r.stop(T0 + 20_000)!;
    expect(ride.summary.distanceM).toBe(0);
    expect(ride.summary.movingSeconds).toBe(0);
    expect(ride.summary.maxSpeedKmh).toBe(0);
  });

  it('thins the stored track but keeps start, end and the full distance', () => {
    const r = new RideRecorder();
    r.start(T0);
    const track = northTrack(601); // 10 minutes, ~6.7 km, a fix every ~11 m
    track.forEach((s) => r.add(s));
    const ride = r.stop(T0 + 600_000)!;
    // At most one point per 25 m (every third fix here) instead of one per second.
    expect(ride.points.length).toBeLessThanOrEqual(202);
    expect(ride.points.length).toBeGreaterThan(150);
    expect(ride.points[0].t).toBe(track[0].timestamp);
    expect(ride.points[ride.points.length - 1].t).toBe(track[600].timestamp);
    expect(ride.summary.distanceM).toBeCloseTo(haversineM(45, 7, 45 + 600 * DLAT, 7), 0);
  });

  it('keeps a point on a sharp turn even when close to the last one', () => {
    const r = new RideRecorder({ minDistanceM: 1000 });
    r.start(T0);
    r.add({ timestamp: T0, latitude: 45, longitude: 7, speedKmh: 30, headingDeg: 0 });
    r.add({ timestamp: T0 + 1000, latitude: 45 + DLAT, longitude: 7, speedKmh: 30, headingDeg: 0 });
    r.add({ timestamp: T0 + 2000, latitude: 45 + DLAT, longitude: 7.0001, speedKmh: 30, headingDeg: 90 });
    // Start and the turn are kept; the straight fix between them was thinned.
    expect(r.live()!.pointCount).toBe(2);
  });

  it('caps memory by decimating, not truncating', () => {
    const r = new RideRecorder({ minDistanceM: 10, maxPoints: 100 });
    r.start(T0);
    const track = northTrack(2000);
    track.forEach((s) => r.add(s));
    const ride = r.stop(T0 + 2_000_000)!;
    expect(ride.points.length).toBeLessThanOrEqual(101);
    expect(ride.points[0].t).toBe(track[0].timestamp);
    expect(ride.points[ride.points.length - 1].t).toBe(track[1999].timestamp);
  });

  it('counts real climbs, not altitude noise', () => {
    const r = new RideRecorder();
    r.start(T0);
    // Flat road with +-3 m noise, then a steady 50 m climb.
    northTrack(60).forEach((s, i) => r.add({ ...s, altitudeM: 300 + (i % 2 ? 3 : -3) }));
    northTrack(51, {}, T0 + 60_000, 45 + 60 * DLAT).forEach((s, i) => r.add({ ...s, altitudeM: 300 + i }));
    const ride = r.stop(T0 + 111_000)!;
    expect(ride.summary.elevationGainM).toBeGreaterThanOrEqual(45);
    expect(ride.summary.elevationGainM).toBeLessThanOrEqual(56);
  });

  it('a second start while recording does not wipe the ride', () => {
    const r = new RideRecorder();
    r.start(T0);
    northTrack(5).forEach((s) => r.add(s));
    r.start(T0 + 5000);
    expect(r.live()!.startedAt).toBe(T0);
  });
});
