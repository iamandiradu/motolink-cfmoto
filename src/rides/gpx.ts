/** GPX 1.1 export. Pure string building, so it runs the same in tests and on the phone. */
import type { Ride } from './recorder';

export function escapeXml(text: string): string {
  return (
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Control characters other than tab/newline are illegal in XML 1.0 even when escaped.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

/** ISO 8601 in UTC, whole seconds: what GPX readers (Strava, Komoot, OsmAnd) all accept. */
export function isoUtc(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Ride 13 Nov 2026 09:30", in the phone's local time because that is how the rider remembers it. */
export function defaultRideName(startedAt: number): string {
  const d = new Date(startedAt);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `Ride ${d.getDate()} ${month} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Coordinates to 7 decimals (~1 cm): more is noise, fewer loses GPS precision. */
const coord = (v: number) => v.toFixed(7).replace(/\.?0+$/, '');

export function toGpx(ride: Ride, name: string = defaultRideName(ride.summary.startedAt)): string {
  const safeName = escapeXml(name);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="MotoLink" xmlns="http://www.topografix.com/GPX/1/1" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    '  <metadata>',
    `    <name>${safeName}</name>`,
    `    <time>${isoUtc(ride.summary.startedAt)}</time>`,
    '  </metadata>',
    '  <trk>',
    `    <name>${safeName}</name>`,
    '    <type>motorcycling</type>',
    '    <trkseg>',
  ];
  for (const p of ride.points) {
    // GPX 1.1 schema order inside trkpt: ele before time.
    const ele = p.ele !== undefined && Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
    lines.push(`      <trkpt lat="${coord(p.lat)}" lon="${coord(p.lon)}">${ele}<time>${isoUtc(p.t)}</time></trkpt>`);
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>', '');
  return lines.join('\n');
}

/**
 * "motolink-2026-11-13-0930.gpx". Only [a-z0-9-] so it survives every share
 * target, file system and mail client; the id suffix keeps two rides started
 * in the same minute apart.
 */
export function gpxFileName(ride: Ride): string {
  const d = new Date(ride.summary.startedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const id = ride.summary.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-4);
  return `motolink-${stamp}${id ? `-${id}` : ''}.gpx`;
}
