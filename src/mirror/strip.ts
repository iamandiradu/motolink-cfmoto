/**
 * The info strip shown beside the mirrored picture (split view): speed, time
 * and the song or trip distance. Pure: builds the texts from app state.
 */

export type StripEdge = 'off' | 'bottom' | 'top';

export interface StripInput {
  edge: StripEdge;
  speedKmh: number | null;
  tripKm: number;
  imperial: boolean;
  now: Date;
  /** Song now playing, when Spotify is connected and playing. */
  trackTitle: string | null;
  /** A warning to show in place of the song or trip distance. */
  alert?: { short: string; urgent: boolean } | null;
}

export interface NativeStrip {
  enabled: boolean;
  edge: 'bottom' | 'top';
  /** Thousandths of the dash height. */
  height: number;
  left: string;
  center: string;
  right: string;
  /** 0xRRGGBB. */
  background: number;
  text: number;
  accent: number;
}

const KM_TO_MI = 0.621371;
/** 15 % of an 384-pixel dash is about 58 pixels: one line of large text. */
const STRIP_HEIGHT = 150;

const two = (n: number) => String(n).padStart(2, '0');

export function buildStrip(input: StripInput): NativeStrip {
  const factor = input.imperial ? KM_TO_MI : 1;
  const unit = input.imperial ? 'mph' : 'km/h';
  const speed = input.speedKmh === null ? '--' : String(Math.round(input.speedKmh * factor));
  const trip = `${(input.tripKm * factor).toFixed(1)} ${input.imperial ? 'mi' : 'km'}`;
  return {
    enabled: input.edge !== 'off',
    edge: input.edge === 'top' ? 'top' : 'bottom',
    height: STRIP_HEIGHT,
    left: `${speed} ${unit}`,
    center: `${two(input.now.getHours())}:${two(input.now.getMinutes())}`,
    // A warning first; then the song when there is one; otherwise the trip distance.
    right: input.alert ? `! ${input.alert.short}` : input.trackTitle ? `♪ ${input.trackTitle}` : trip,
    background: 0x000000,
    text: 0xffffff,
    // Blue normally; pink marks a warning, amber a milder one.
    accent: input.alert ? (input.alert.urgent ? 0xff3d97 : 0xffb020) : 0x00aeef,
  };
}

/** True when two strips would look the same, so nothing needs sending. */
export function sameStrip(a: NativeStrip | null, b: NativeStrip): boolean {
  return (
    a !== null &&
    a.enabled === b.enabled &&
    a.edge === b.edge &&
    a.left === b.left &&
    a.center === b.center &&
    a.right === b.right &&
    a.accent === b.accent
  );
}
