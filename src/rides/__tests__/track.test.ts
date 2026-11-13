import type { RidePoint } from '../recorder';
import { BAND_COLORS, regionForTrack, speedBands, speedLegend } from '../track';

const T0 = Date.UTC(2026, 10, 13, 8, 0, 0);
/** ~11.1 m per 0.0001 deg of latitude. */
const DLAT = 0.0001;

/** Points 1 s apart moving north at roughly the given speed. */
function run(start: RidePoint, kmh: number, n: number): RidePoint[] {
  const step = (kmh / 3.6 / 11.1) * DLAT;
  return Array.from({ length: n }, (_, i) => ({ t: start.t + (i + 1) * 1000, lat: start.lat + (i + 1) * step, lon: start.lon }));
}

describe('speedBands', () => {
  it('has a legend with numbers for every band', () => {
    const legend = speedLegend();
    expect(legend.map((b) => b.label)).toEqual(['Under 30 km/h', '30–60 km/h', '60–90 km/h', '90 km/h and over']);
    expect(legend.map((b) => b.color)).toEqual([...BAND_COLORS]);
    expect(speedLegend({ imperial: true })[1].label).toBe('20–40 mph');
    expect(speedLegend({ imperial: true })[1].minKmh).toBeCloseTo(32.19, 1);
  });

  it('splits the track where the speed band changes, without gaps', () => {
    const p0: RidePoint = { t: T0, lat: 45, lon: 7 };
    const slow = run(p0, 20, 5);
    const fast = run(slow[slow.length - 1], 100, 5);
    const mid = run(fast[fast.length - 1], 45, 5);
    const { segments } = speedBands([p0, ...slow, ...fast, ...mid]);
    expect(segments.map((s) => s.band)).toEqual([0, 3, 1]);
    expect(segments[0].coordinates).toHaveLength(6);
    // Each segment starts where the previous one ended.
    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1].coordinates;
      expect(segments[i].coordinates[0]).toEqual(prev[prev.length - 1]);
    }
    expect(segments[1].color).toBe(BAND_COLORS[3]);
  });

  it('handles empty, single point and duplicate timestamps', () => {
    expect(speedBands([]).segments).toEqual([]);
    expect(speedBands([{ t: T0, lat: 45, lon: 7 }]).segments).toEqual([]);
    const same = speedBands([
      { t: T0, lat: 45, lon: 7 },
      { t: T0, lat: 45.001, lon: 7 },
    ]);
    expect(same.segments).toHaveLength(1);
  });

  it('does not draw a line round the world across the antimeridian', () => {
    const { segments } = speedBands([
      { t: T0, lat: -17, lon: 179.999 },
      { t: T0 + 1000, lat: -17, lon: 179.9998 },
      { t: T0 + 2000, lat: -17, lon: -179.9998 },
      { t: T0 + 3000, lat: -17, lon: -179.999 },
    ]);
    for (const s of segments) {
      for (let i = 1; i < s.coordinates.length; i++) {
        expect(Math.abs(s.coordinates[i].longitude - s.coordinates[i - 1].longitude)).toBeLessThan(180);
      }
    }
    expect(segments).toHaveLength(2);
  });
});

describe('regionForTrack', () => {
  it('returns null without points', () => {
    expect(regionForTrack([])).toBeNull();
  });

  it('gives a single point a minimum span', () => {
    expect(regionForTrack([{ lat: 45, lon: 7 }])).toEqual({ latitude: 45, longitude: 7, latitudeDelta: 0.005, longitudeDelta: 0.005 });
  });

  it('centres on the track with padding', () => {
    const r = regionForTrack(
      [
        { lat: 45, lon: 7 },
        { lat: 46, lon: 8 },
        { lat: 45.5, lon: 7.2 },
      ],
      { padding: 0.1 },
    )!;
    expect(r.latitude).toBeCloseTo(45.5);
    expect(r.longitude).toBeCloseTo(7.5);
    expect(r.latitudeDelta).toBeCloseTo(1.2);
    expect(r.longitudeDelta).toBeCloseTo(1.2);
  });

  it('fits a track across the antimeridian narrowly', () => {
    const r = regionForTrack([
      { lat: -17, lon: 179.8 },
      { lat: -17.1, lon: -179.9 },
    ])!;
    expect(r.longitudeDelta).toBeLessThan(1);
    expect(Math.abs(r.longitude)).toBeGreaterThan(179.9);
    expect(r.longitude).toBeGreaterThanOrEqual(-180);
    expect(r.longitude).toBeLessThanOrEqual(180);
  });

  it('ignores non-finite points', () => {
    expect(regionForTrack([{ lat: NaN, lon: 7 }])).toBeNull();
  });
});
