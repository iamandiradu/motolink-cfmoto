import { sunTimes, themeForTime, TWILIGHT_MARGIN_MS } from '../sun';

const BUCHAREST = { lat: 44.43, lon: 26.1 };

/** Minutes between a Date and an ISO UTC time. */
const offBy = (d: Date | null, iso: string) => Math.abs((d!.getTime() - Date.parse(iso)) / 60_000);

describe('sunTimes', () => {
  // Published times (timeanddate.com), converted to UTC: EEST is UTC+3, EET UTC+2.
  it.each([
    ['summer solstice', '2026-06-21T12:00:00Z', '2026-06-21T02:31:00Z', '2026-06-21T18:03:00Z'],
    ['winter solstice', '2026-12-21T12:00:00Z', '2026-12-21T05:51:00Z', '2026-12-21T14:38:00Z'],
    ['March equinox', '2026-03-20T12:00:00Z', '2026-03-20T04:21:00Z', '2026-03-20T16:31:00Z'],
  ])('Bucharest, %s', (_name, at, rise, set) => {
    const sun = sunTimes(new Date(at), BUCHAREST.lat, BUCHAREST.lon);
    expect(sun.polar).toBeNull();
    expect(offBy(sun.sunrise, rise)).toBeLessThan(4);
    expect(offBy(sun.sunset, set)).toBeLessThan(4);
  });

  it('uses the local solar day, not the UTC day', () => {
    // 23:30 UTC on 20 June is already 21 June in Bucharest.
    const sun = sunTimes(new Date('2026-06-20T23:30:00Z'), BUCHAREST.lat, BUCHAREST.lon);
    expect(offBy(sun.sunrise, '2026-06-21T02:31:00Z')).toBeLessThan(4);
  });

  it('works west of Greenwich (New York, 40.71 N 74.01 W, 21 June)', () => {
    const sun = sunTimes(new Date('2026-06-21T16:00:00Z'), 40.71, -74.01);
    // 05:25 and 20:31 EDT (UTC-4).
    expect(offBy(sun.sunrise, '2026-06-21T09:25:00Z')).toBeLessThan(4);
    expect(offBy(sun.sunset, '2026-06-22T00:31:00Z')).toBeLessThan(4);
  });

  it('returns null times in polar day and polar night (Tromsø 69.65 N)', () => {
    expect(sunTimes(new Date('2026-06-21T12:00:00Z'), 69.65, 18.96)).toEqual({ sunrise: null, sunset: null, polar: 'day' });
    expect(sunTimes(new Date('2026-12-21T12:00:00Z'), 69.65, 18.96)).toEqual({ sunrise: null, sunset: null, polar: 'night' });
  });
});

describe('themeForTime', () => {
  const base = { latitude: BUCHAREST.lat, longitude: BUCHAREST.lon, dayTheme: 'day', nightTheme: 'aurora' } as const;
  const sun = sunTimes(new Date('2026-06-21T12:00:00Z'), BUCHAREST.lat, BUCHAREST.lon);
  const at = (d: Date, deltaMin: number) => new Date(d.getTime() + deltaMin * 60_000);

  it('is day at noon and night at midnight', () => {
    expect(themeForTime({ ...base, now: new Date('2026-06-21T10:00:00Z') })).toBe('day');
    expect(themeForTime({ ...base, now: new Date('2026-06-21T22:00:00Z') })).toBe('aurora');
  });

  it('switches to night about 20 minutes after sunset', () => {
    expect(TWILIGHT_MARGIN_MS).toBe(20 * 60_000);
    expect(themeForTime({ ...base, now: at(sun.sunset!, 19) })).toBe('day');
    expect(themeForTime({ ...base, now: at(sun.sunset!, 21) })).toBe('aurora');
  });

  it('switches to day about 20 minutes before sunrise', () => {
    expect(themeForTime({ ...base, now: at(sun.sunrise!, -21) })).toBe('aurora');
    expect(themeForTime({ ...base, now: at(sun.sunrise!, -19) })).toBe('day');
  });

  it('keeps the current theme when the position is unknown', () => {
    const now = new Date('2026-06-21T22:00:00Z');
    expect(themeForTime({ ...base, latitude: null, now, currentTheme: 'neon' })).toBe('neon');
    expect(themeForTime({ ...base, longitude: null, now })).toBe('day');
  });

  it('follows polar day and night', () => {
    const far = { ...base, latitude: 69.65, longitude: 18.96 };
    expect(themeForTime({ ...far, now: new Date('2026-06-21T23:00:00Z') })).toBe('day');
    expect(themeForTime({ ...far, now: new Date('2026-12-21T11:00:00Z') })).toBe('aurora');
  });
});
