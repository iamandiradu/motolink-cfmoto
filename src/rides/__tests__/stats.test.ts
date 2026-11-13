import type { RideSummary } from '../recorder';
import { monthlyBuckets, rideTotals } from '../stats';

/** Local-time dates, so the tests hold in any time zone the suite runs in. */
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m, d, h, min).getTime();

function ride(id: string, startedAt: number, km: number, extra: Partial<RideSummary> = {}): RideSummary {
  return {
    id,
    startedAt,
    endedAt: startedAt + 3600_000,
    distanceM: km * 1000,
    movingSeconds: 3000,
    totalSeconds: 3600,
    maxSpeedKmh: 100,
    avgSpeedKmh: 60,
    elevationGainM: 0,
    pointCount: 10,
    ...extra,
  };
}

describe('rideTotals', () => {
  it('is all zero with no rides', () => {
    expect(rideTotals([])).toEqual({ rides: 0, distanceM: 0, movingSeconds: 0, longest: null, topSpeedKmh: 0, climbM: 0 });
  });

  it('adds up every ride', () => {
    const rides = [
      ride('a', local(2026, 10, 1), 50, { maxSpeedKmh: 120, elevationGainM: 300 }),
      ride('b', local(2026, 9, 1), 210, { movingSeconds: 9000 }),
      ride('c', local(2026, 8, 1), 20, { elevationGainM: 45 }),
    ];
    const t = rideTotals(rides);
    expect(t.rides).toBe(3);
    expect(t.distanceM).toBe(280_000);
    expect(t.movingSeconds).toBe(15_000);
    expect(t.longest?.id).toBe('b');
    expect(t.topSpeedKmh).toBe(120);
    expect(t.climbM).toBe(345);
  });
});

describe('monthlyBuckets', () => {
  const now = local(2026, 10, 13); // 13 Nov 2026

  it('returns the last 12 months, oldest first, ending this month', () => {
    const b = monthlyBuckets([], now);
    expect(b).toHaveLength(12);
    expect(b[0]).toMatchObject({ key: '2025-12', year: 2025, month: 11, label: 'Dec' });
    expect(b[11]).toMatchObject({ key: '2026-11', year: 2026, month: 10, label: 'Nov' });
    expect(b.every((m) => m.distanceM === 0 && m.rides === 0)).toBe(true);
  });

  it('puts rides in their local month, including at month edges', () => {
    const rides = [
      ride('a', local(2026, 10, 1, 0, 5), 10), // just after midnight on 1 Nov
      ride('b', local(2026, 9, 31, 23, 55), 20), // just before midnight on 31 Oct
      ride('c', local(2026, 9, 15), 5),
      ride('d', local(2025, 11, 1, 0, 1), 7), // oldest bucket
      ride('e', local(2025, 10, 30, 23, 59), 99), // too old
      ride('f', local(2026, 11, 1), 99), // future month: not shown
    ];
    const b = monthlyBuckets(rides, now);
    const byKey = Object.fromEntries(b.map((m) => [m.key, m]));
    expect(byKey['2026-11']).toMatchObject({ rides: 1, distanceM: 10_000 });
    expect(byKey['2026-10']).toMatchObject({ rides: 2, distanceM: 25_000 });
    expect(byKey['2025-12']).toMatchObject({ rides: 1, distanceM: 7_000 });
    expect(b.reduce((s, m) => s + m.rides, 0)).toBe(4);
  });

  it('crosses a year boundary at the start of the year', () => {
    const b = monthlyBuckets([], local(2026, 0, 31, 23, 30));
    expect(b[0].key).toBe('2025-02');
    expect(b[11].key).toBe('2026-01');
  });
});
