/**
 * Glove mode: bigger targets and less text for gloved fingers. Pure; the
 * screens apply the scale.
 */

export type GloveMode = 'off' | 'on' | 'whenConnected';

export interface GloveScale {
  active: boolean;
  /** Smallest touch target, points. */
  minTouch: number;
  /** Points added to body and label font sizes. */
  fontBump: number;
  /** Multiplier for font sizes, for screens that scale rather than add. */
  fontScale: number;
  /** Hide hints and secondary (dim) text. */
  hideSecondaryText: boolean;
  /** Space between controls, points. */
  gap: number;
}

export const NORMAL_SCALE: GloveScale = {
  active: false,
  minTouch: 44,
  fontBump: 0,
  fontScale: 1,
  hideSecondaryText: false,
  gap: 8,
};

export const GLOVE_SCALE: GloveScale = {
  active: true,
  minTouch: 64,
  fontBump: 4,
  fontScale: 1.25,
  hideSecondaryText: true,
  gap: 14,
};

/** `connected`: the phone is linked to the bike right now. */
export function gloveScale(mode: GloveMode, connected: boolean): GloveScale {
  const on = mode === 'on' || (mode === 'whenConnected' && connected);
  return on ? GLOVE_SCALE : NORMAL_SCALE;
}
