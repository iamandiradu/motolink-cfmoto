/**
 * Map helpers for a saved track. Pure: no React, no map library.
 */
import { haversineM } from '../metrics/trip';
import type { RidePoint } from './recorder';

const KM_TO_MI = 0.621371;

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface SpeedBand {
  /** Index into the band list, slowest first. */
  index: number;
  /** Lower bound, km/h (inclusive). */
  minKmh: number;
  /** Upper bound, km/h (exclusive); Infinity for the top band. */
  maxKmh: number;
  color: string;
  /** Text for the legend, with numbers and units, e.g. "30–60 km/h". */
  label: string;
}

export interface SpeedSegment {
  band: number;
  color: string;
  coordinates: LatLng[];
}

export interface SpeedBandsResult {
  segments: SpeedSegment[];
  legend: SpeedBand[];
}

/** Slow to fast. Distinct in hue and lightness, readable on light and dark map tiles. */
export const BAND_COLORS = ['#3d8bff', '#3ddc84', '#ffb020', '#ff3d97'] as const;

/** Band edges in the rider's unit. */
const METRIC_EDGES = [30, 60, 90];
const IMPERIAL_EDGES = [20, 40, 60];

export interface SpeedBandsOptions {
  imperial?: boolean;
}

export function speedLegend({ imperial = false }: SpeedBandsOptions = {}): SpeedBand[] {
  const edges = imperial ? IMPERIAL_EDGES : METRIC_EDGES;
  const unit = imperial ? 'mph' : 'km/h';
  const toKmh = (v: number) => (imperial ? v / KM_TO_MI : v);
  return BAND_COLORS.map((color, index) => {
    const lo = index === 0 ? 0 : edges[index - 1];
    const hi = index < edges.length ? edges[index] : Infinity;
    const label = index === 0 ? `Under ${hi} ${unit}` : hi === Infinity ? `${lo} ${unit} and over` : `${lo}–${hi} ${unit}`;
    return { index, minKmh: toKmh(lo), maxKmh: toKmh(hi), color, label };
  });
}

function bandFor(legend: SpeedBand[], kmh: number): number {
  for (const b of legend) if (kmh < b.maxKmh) return b.index;
  return legend.length - 1;
}

const toLatLng = (p: RidePoint): LatLng => ({ latitude: p.lat, longitude: p.lon });

/**
 * Splits a track into polylines, one per run of the same speed band. Speed is
 * distance over time between consecutive points. Adjacent segments share their
 * joining point so the line has no gaps. A step across the antimeridian starts
 * a new segment instead of drawing a line round the world.
 */
export function speedBands(points: readonly RidePoint[], options: SpeedBandsOptions = {}): SpeedBandsResult {
  const legend = speedLegend(options);
  const segments: SpeedSegment[] = [];
  let current: SpeedSegment | null = null;
  let lastBand = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = (b.t - a.t) / 1000;
    // Average speed over the step. Over a long gap (tunnel, pause) that is
    // still the honest figure: distance covered over time taken.
    const band = dt > 0 ? bandFor(legend, (haversineM(a.lat, a.lon, b.lat, b.lon) / dt) * 3.6) : lastBand;
    lastBand = band;

    const crossesAntimeridian = Math.abs(b.lon - a.lon) > 180;
    if (crossesAntimeridian) {
      current = null;
      continue;
    }
    if (current && current.band === band) {
      current.coordinates.push(toLatLng(b));
    } else {
      current = { band, color: legend[band].color, coordinates: [toLatLng(a), toLatLng(b)] };
      segments.push(current);
    }
  }
  return { segments, legend };
}

export interface Region {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

export interface RegionOptions {
  /** Extra space around the track, as a share of its span on each side. */
  padding?: number;
  /** Smallest span in degrees, so a single point or a short ride is not zoomed to the street level. */
  minDelta?: number;
}

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * The map region that shows the whole track with padding. null without points.
 * Longitudes are taken on whichever side of the antimeridian gives the
 * narrower span, so a ride across it (Fiji, Chukotka) is not fitted as a
 * world-wide strip.
 */
export function regionForTrack(points: readonly { lat: number; lon: number }[], options: RegionOptions = {}): Region | null {
  const padding = options.padding ?? 0.15;
  const minDelta = options.minDelta ?? 0.005;
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (valid.length === 0) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minShifted = Infinity;
  let maxShifted = -Infinity;
  for (const p of valid) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
    // Same longitudes on 0..360: a track across 180 is contiguous here.
    const shifted = p.lon < 0 ? p.lon + 360 : p.lon;
    minShifted = Math.min(minShifted, shifted);
    maxShifted = Math.max(maxShifted, shifted);
  }
  let lonSpan = maxLon - minLon;
  let lonCenter = (minLon + maxLon) / 2;
  if (maxShifted - minShifted < lonSpan) {
    lonSpan = maxShifted - minShifted;
    lonCenter = wrapLon((minShifted + maxShifted) / 2);
  }
  const latSpan = maxLat - minLat;
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: lonCenter,
    latitudeDelta: Math.min(180, Math.max(minDelta, latSpan * (1 + 2 * padding))),
    longitudeDelta: Math.min(360, Math.max(minDelta, lonSpan * (1 + 2 * padding))),
  };
}
