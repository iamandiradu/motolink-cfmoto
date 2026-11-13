/**
 * Sunrise and sunset, and the dash theme that suits the time of day.
 *
 * NOAA solar calculator equations (good to about a minute away from the
 * poles). Pure: no clock, no location access.
 */

export interface SunTimes {
  /** null on a day the sun does not rise or set (polar day or night). */
  sunrise: Date | null;
  sunset: Date | null;
  /** 'day' when the sun stays up, 'night' when it stays down, else null. */
  polar: 'day' | 'night' | null;
}

const DAY_MS = 86_400_000;
const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Sun declination (radians) and equation of time (minutes) at a Julian day. */
function solarPosition(julianDay: number) {
  const t = (julianDay - 2451545) / 36525;
  const l0 = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(rad(m)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(rad(2 * m)) * (0.019993 - 0.000101 * t) +
    Math.sin(rad(3 * m)) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const declination = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const equationOfTime =
    4 *
    deg(
      y * Math.sin(2 * rad(l0)) -
        2 * e * Math.sin(rad(m)) +
        4 * e * y * Math.sin(rad(m)) * Math.cos(2 * rad(l0)) -
        0.5 * y * y * Math.sin(4 * rad(l0)) -
        1.25 * e * e * Math.sin(2 * rad(m)),
    );
  return { declination, equationOfTime };
}

/**
 * Sunrise and sunset on the local solar day that contains `date` at the given
 * place. Latitude in degrees north, longitude in degrees east.
 */
export function sunTimes(date: Date, latitude: number, longitude: number): SunTimes {
  // Local mean solar day: UTC shifted by the longitude, so the day runs from
  // about local midnight to local midnight wherever the rider is.
  const day = Math.floor((date.getTime() + (longitude / 360) * DAY_MS) / DAY_MS);
  const dayStartMs = day * DAY_MS;
  const julianDay0 = day + 2440587.5;
  const lat = rad(Math.max(-89.99, Math.min(89.99, latitude)));

  // Two passes: the second evaluates the sun's position at that day's noon.
  let noon = 720 - 4 * longitude;
  let hourAngle = 0;
  for (let pass = 0; pass < 2; pass++) {
    const { declination, equationOfTime } = solarPosition(julianDay0 + noon / 1440);
    noon = 720 - 4 * longitude - equationOfTime;
    const cosH = Math.cos(rad(90.833)) / (Math.cos(lat) * Math.cos(declination)) - Math.tan(lat) * Math.tan(declination);
    if (cosH > 1) return { sunrise: null, sunset: null, polar: 'night' };
    if (cosH < -1) return { sunrise: null, sunset: null, polar: 'day' };
    hourAngle = deg(Math.acos(cosH));
  }
  return {
    sunrise: new Date(dayStartMs + (noon - 4 * hourAngle) * 60_000),
    sunset: new Date(dayStartMs + (noon + 4 * hourAngle) * 60_000),
    polar: null,
  };
}

/** Night theme until this long before sunrise, and from this long after sunset. */
export const TWILIGHT_MARGIN_MS = 20 * 60_000;

export interface ThemeForTimeInput<T extends string> {
  now: Date;
  latitude: number | null;
  longitude: number | null;
  dayTheme: T;
  nightTheme: T;
  /** Kept when the position is unknown. Defaults to dayTheme. */
  currentTheme?: T;
}

/** True when it is light enough for the day theme. null without a position. */
export function isDaylight(now: Date, latitude: number | null, longitude: number | null): boolean | null {
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  const sun = sunTimes(now, latitude, longitude);
  if (sun.polar) return sun.polar === 'day';
  const t = now.getTime();
  return t >= sun.sunrise!.getTime() - TWILIGHT_MARGIN_MS && t < sun.sunset!.getTime() + TWILIGHT_MARGIN_MS;
}

/** The theme for this moment: day theme in daylight, night theme in the dark. */
export function themeForTime<T extends string>(input: ThemeForTimeInput<T>): T {
  const light = isDaylight(input.now, input.latitude, input.longitude);
  if (light === null) return input.currentTheme ?? input.dayTheme;
  return light ? input.dayTheme : input.nightTheme;
}
