/**
 * Bike profiles: what we expect from each CFMOTO dash of the Carbit
 * EasyConn family. Most facts come from the Android reference projects, which
 * were run on other bikes than the 450 MT. Every profile says which of its
 * values are guesses so the app (and whoever extends this list) can tell
 * recorded data from assumptions.
 */
import type { Gesture } from '../buttons/gestures';
import { ButtonLayout, DEFAULT_LAYOUT, DashAction } from '../buttons/mapping';

/** ap: the dash is a plain access point (192.168.0.1). p2p: Wi-Fi Direct group (192.168.49.1). */
export type WifiKind = 'ap' | 'p2p';

export interface PanelSize {
  width: number;
  height: number;
}

/** Profile fields that can hold a guess rather than recorded data. */
export type ProfileField = 'modelIds' | 'sdkPrefixes' | 'panel' | 'wifi' | 'touch' | 'supportFunction' | 'layout';

export interface BikeProfile {
  /** Stable slug, used as the stored choice. */
  id: string;
  name: string;
  /** Dash hardware family, when known (CFDL16, CFDL26...). */
  dash: string | null;
  /** `modelid` values from the pairing QR. Empty when none is known. */
  modelIds: readonly string[];
  /** CLIENT_INFO sdkVersion prefixes, compared segment by segment ("1.1" matches "1.1.4"). */
  sdkPrefixes: readonly string[];
  /** Panel size the dash asks for in CONFIG_CAPTURE, null when nobody recorded it. */
  panel: PanelSize | null;
  /**
   * When the panel is unknown: the width we expect for a landscape panel.
   * Only a weak hint; it never rules a profile out.
   */
  panelWidthHint?: number;
  /** null when unknown. */
  wifi: WifiKind | null;
  /** Dash reports touch input. null when unknown. */
  touch: boolean | null;
  /** Phone identity `supportFunction` to send. null: keep the app setting. */
  supportFunction: number | null;
  /** Gestures that differ from the app's DEFAULT_LAYOUT on this bike. */
  layout?: Partial<ButtonLayout>;
  /** True when real data from that bike backs the profile. */
  verified: boolean;
  /** Fields that hold a value nobody recorded on this bike. A null field is unknown, not a guess. */
  guessed: readonly ProfileField[];
  notes: string;
}

export const GENERIC_PROFILE_ID = 'generic';

export const BIKE_PROFILES: readonly BikeProfile[] = [
  {
    id: '450mt',
    name: 'CFMOTO 450 MT',
    dash: null,
    // Nobody has recorded its modelid or sdkVersion; they are learned on the first connection.
    modelIds: [],
    sdkPrefixes: [],
    panel: null,
    panelWidthHint: 800,
    wifi: 'ap',
    touch: false,
    // Rule from the Android projects: 0 only on legacy CFDL16 and CL-C450 dashes.
    // Which family the 450 MT dash belongs to is not known, hence a guess.
    // The Android reference apps treat the 450 MT as a legacy CFDL16 dash, which takes 0.
    supportFunction: 0,
    // The owner's manual matches DEFAULT_LAYOUT (Up press = volume up, Up hold = previous track).
    verified: false,
    guessed: ['supportFunction'],
    notes:
      'Wi-Fi access point and no touch screen are known. Model id, dash software and panel size are not: ' +
      'expected an 800-wide landscape panel. Down is assumed to mirror Up.',
  },
  {
    id: '450sr',
    name: 'CFMOTO 450SR',
    dash: 'CFDL16 (MotoPlay landscape)',
    modelIds: ['66660742'],
    // 0.9.29.1 was recorded on a CFDL16 dash, not on a 450SR itself.
    sdkPrefixes: ['0.9.29'],
    panel: { width: 800, height: 400 },
    wifi: 'p2p',
    touch: false,
    supportFunction: 128,
    verified: true,
    guessed: ['sdkPrefixes', 'supportFunction'],
    notes: 'Wi-Fi Direct group. Same model id is used by other 450-class bikes.',
  },
  {
    id: '675sr-r',
    name: 'CFMOTO 675SR-R',
    dash: 'CFDL16',
    modelIds: ['37416'],
    sdkPrefixes: ['0.9.29'],
    panel: { width: 800, height: 386 },
    wifi: null,
    touch: false,
    supportFunction: 0,
    verified: true,
    guessed: [],
    notes: 'Legacy CFDL16 dash: supportFunction 0.',
  },
  {
    id: '800mt',
    name: 'CFMOTO 800MT',
    dash: 'CFDL26',
    modelIds: ['37426'],
    sdkPrefixes: ['1.1'],
    panel: { width: 1280, height: 576 },
    wifi: null,
    touch: true,
    supportFunction: 128,
    verified: true,
    guessed: [],
    notes: 'Model id 37426 is shared with the 1000MT-X and 800NK Advanced.',
  },
  {
    id: '800nk-advanced',
    name: 'CFMOTO 800NK Advanced',
    dash: 'CFDL26',
    modelIds: ['37426'],
    sdkPrefixes: ['1.1'],
    panel: { width: 720, height: 712 },
    wifi: null,
    touch: true,
    supportFunction: 128,
    verified: true,
    guessed: [],
    notes: 'Model id 37426 is shared with the 1000MT-X and 800MT.',
  },
  {
    id: '800nk-us',
    name: 'CFMOTO 800NK (US)',
    dash: null,
    modelIds: ['66660703', '66660721', '66660732'],
    sdkPrefixes: ['0.9.23'],
    panel: null,
    wifi: null,
    touch: null,
    supportFunction: 128,
    verified: true,
    guessed: [],
    notes: 'US market dash. Panel size not recorded.',
  },
  {
    id: '1000mt-x',
    name: 'CFMOTO 1000MT-X',
    dash: 'CFDL26',
    modelIds: ['37426'],
    sdkPrefixes: ['1.1'],
    panel: { width: 800, height: 951 },
    wifi: 'p2p',
    touch: null,
    supportFunction: 128,
    verified: true,
    guessed: [],
    notes: 'Upright panel. Wi-Fi Direct group. Model id 37426 is shared with the 800MT and 800NK Advanced.',
  },
  {
    id: 'cl-c450',
    name: 'CFMOTO CL-C 450',
    dash: null,
    modelIds: ['66660736'],
    sdkPrefixes: [],
    panel: { width: 544, height: 512 },
    wifi: null,
    touch: false,
    supportFunction: 0,
    verified: true,
    guessed: [],
    notes: 'Uses supportFunction 0, like the legacy CFDL16 dashes.',
  },
  {
    id: GENERIC_PROFILE_ID,
    name: 'Other CFMOTO',
    dash: null,
    modelIds: [],
    sdkPrefixes: [],
    panel: null,
    wifi: null,
    touch: null,
    supportFunction: null,
    verified: false,
    guessed: [],
    notes: 'No profile fits. The app uses its own settings and the size the dash asks for.',
  },
];

export const GENERIC_PROFILE: BikeProfile = BIKE_PROFILES.find((p) => p.id === GENERIC_PROFILE_ID)!;

export function isBuiltInProfileId(id: string): boolean {
  return BIKE_PROFILES.some((p) => p.id === id);
}

/** Built-in profiles followed by imported ones. An imported id never shadows a built-in one. */
export function allProfiles(custom: readonly BikeProfile[] = []): readonly BikeProfile[] {
  return [...BIKE_PROFILES, ...custom.filter((p) => !isBuiltInProfileId(p.id))];
}

export function findProfile(id: string | null | undefined, profiles: readonly BikeProfile[] = BIKE_PROFILES): BikeProfile | null {
  if (!id) return null;
  return profiles.find((p) => p.id === id) ?? null;
}

/** Segment-wise prefix: "0.9.29" matches "0.9.29.1" but not "0.9.290". */
export function sdkMatches(prefix: string, version: string): boolean {
  const want = prefix.split('.').filter(Boolean);
  const have = version.trim().split('.');
  if (want.length === 0 || want.length > have.length) return false;
  return want.every((segment, i) => segment === have[i]);
}

/** Starting layout for a bike: the app default with the profile's differences applied. */
export function defaultLayoutFor(profile: BikeProfile): ButtonLayout {
  const layout: ButtonLayout = { ...DEFAULT_LAYOUT };
  if (profile.layout) {
    for (const [gesture, action] of Object.entries(profile.layout) as [Gesture, DashAction | undefined][]) {
      if (action) layout[gesture] = action;
    }
  }
  return layout;
}
