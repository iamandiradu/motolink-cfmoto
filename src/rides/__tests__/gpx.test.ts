import { escapeXml, gpxFileName, isoUtc, toGpx } from '../gpx';
import type { Ride } from '../recorder';

const T0 = Date.UTC(2026, 10, 13, 8, 0, 0, 450);

const ride: Ride = {
  summary: {
    id: 'abc-12xy',
    startedAt: T0,
    endedAt: T0 + 60_000,
    distanceM: 1000,
    movingSeconds: 60,
    totalSeconds: 60,
    maxSpeedKmh: 70,
    avgSpeedKmh: 60,
    elevationGainM: 0,
    pointCount: 2,
  },
  points: [
    { t: T0, lat: 45.1234567, lon: 7.5, ele: 301.26 },
    { t: T0 + 60_000, lat: 45.13, lon: -7.25 },
  ],
};

describe('GPX export', () => {
  it('writes a GPX 1.1 document with one track segment', () => {
    const xml = toGpx(ride, 'Test');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<gpx version="1.1" creator="MotoLink" xmlns="http://www.topografix.com/GPX/1/1"');
    expect(xml.match(/<trk>/g)).toHaveLength(1);
    expect(xml.match(/<trkseg>/g)).toHaveLength(1);
    expect(xml.match(/<trkpt /g)).toHaveLength(2);
    expect(xml).toContain('<trkpt lat="45.1234567" lon="7.5"><ele>301.3</ele><time>2026-11-13T08:00:00Z</time></trkpt>');
    expect(xml).toContain('<trkpt lat="45.13" lon="-7.25"><time>2026-11-13T08:01:00Z</time></trkpt>');
    expect(xml).toContain('<metadata>\n    <name>Test</name>\n    <time>2026-11-13T08:00:00Z</time>');
    expect(xml.trim().endsWith('</gpx>')).toBe(true);
    // Every opened element is closed.
    for (const tag of ['gpx', 'metadata', 'trk', 'trkseg', 'name', 'time']) {
      const open = (xml.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
      const close = (xml.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      expect(close).toBe(open);
    }
  });

  it('escapes names', () => {
    const xml = toGpx(ride, `Tom & Jerry's <"ride">\u0001`);
    expect(xml).toContain('<name>Tom &amp; Jerry&apos;s &lt;&quot;ride&quot;&gt;</name>');
    expect(escapeXml('a&b')).toBe('a&amp;b');
  });

  it('writes times in UTC whatever the phone time zone', () => {
    expect(isoUtc(Date.UTC(2026, 0, 1, 23, 59, 59, 999))).toBe('2026-01-01T23:59:59Z');
    expect(toGpx(ride)).not.toMatch(/<time>[^<]*[+-]\d\d:\d\d<\/time>/);
  });

  it('builds a safe file name', () => {
    const name = gpxFileName({ ...ride, summary: { ...ride.summary, id: '../Évil/..id' } });
    expect(name).toMatch(/^motolink-\d{4}-\d{2}-\d{2}-\d{4}(-[a-z0-9]{1,4})?\.gpx$/);
    expect(gpxFileName(ride)).toMatch(/-12xy\.gpx$/);
  });
});
