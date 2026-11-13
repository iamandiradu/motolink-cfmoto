/**
 * Picture settings (crop, zoom, fit) remembered per navigation app. Each app
 * puts its own buttons and bars in different places, so one trim does not
 * suit all of them.
 */

export interface MirrorView {
  /** 100 = no zoom. */
  zoom: number;
  /** Percent cut from each edge of the upright picture. */
  trimTop: number;
  trimBottom: number;
  trimLeft: number;
  trimRight: number;
  /** auto: a sideways screen fills the dash, an upright one is shown whole. */
  fit: 'auto' | 'fill' | 'fit';
}

export const DEFAULT_MIRROR_VIEW: MirrorView = {
  zoom: 100,
  trimTop: 0,
  trimBottom: 0,
  trimLeft: 0,
  trimRight: 0,
  fit: 'auto',
};

export const PRESET_IDS = ['general', 'appleMaps', 'googleMaps', 'waze'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface PresetApp {
  id: PresetId;
  label: string;
  /** URL scheme that opens the app; null for the general preset. */
  url: string | null;
}

/** iOS URL schemes. On Android, web links open the installed app; Apple Maps does not exist there. */
export function presetApps(platform: string): readonly PresetApp[] {
  const android = platform === 'android';
  return [
    { id: 'general', label: 'Any app', url: null },
    ...(android ? [] : [{ id: 'appleMaps' as const, label: 'Apple Maps', url: 'maps://' }]),
    { id: 'googleMaps', label: 'Google Maps', url: android ? 'https://www.google.com/maps' : 'comgooglemaps://' },
    { id: 'waze', label: 'Waze', url: android ? 'https://waze.com/ul' : 'waze://' },
  ];
}

export const PRESET_APPS: readonly PresetApp[] = presetApps('ios');

export type MirrorPresets = Record<PresetId, MirrorView>;

export function defaultPresets(): MirrorPresets {
  return {
    general: { ...DEFAULT_MIRROR_VIEW },
    appleMaps: { ...DEFAULT_MIRROR_VIEW },
    googleMaps: { ...DEFAULT_MIRROR_VIEW },
    waze: { ...DEFAULT_MIRROR_VIEW },
  };
}

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Reads one stored view; anything missing or out of range falls back to the default. */
export function normaliseView(stored: unknown): MirrorView {
  const source = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const fit = source.fit === 'fill' || source.fit === 'fit' ? source.fit : 'auto';
  return {
    zoom: clamp(source.zoom, 100, 250, 100),
    trimTop: clamp(source.trimTop, 0, 40, 0),
    trimBottom: clamp(source.trimBottom, 0, 40, 0),
    trimLeft: clamp(source.trimLeft, 0, 40, 0),
    trimRight: clamp(source.trimRight, 0, 40, 0),
    fit,
  };
}

/**
 * Reads stored presets. `legacy` is the single view older versions saved; it
 * becomes the general preset so nobody loses their adjustment on update.
 */
export function normalisePresets(stored: unknown, legacy?: unknown): MirrorPresets {
  const source = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const presets = defaultPresets();
  for (const id of PRESET_IDS) {
    if (source[id] !== undefined) presets[id] = normaliseView(source[id]);
  }
  if (source.general === undefined && legacy !== undefined) presets.general = normaliseView(legacy);
  return presets;
}

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value);
}

export function isDefaultView(view: MirrorView): boolean {
  return (Object.keys(DEFAULT_MIRROR_VIEW) as (keyof MirrorView)[]).every(
    (key) => view[key] === DEFAULT_MIRROR_VIEW[key],
  );
}

export function updatePreset(presets: MirrorPresets, id: PresetId, patch: Partial<MirrorView>): MirrorPresets {
  return { ...presets, [id]: normaliseView({ ...presets[id], ...patch }) };
}

/** What the native side takes: thousandths, and a numeric fit code. */
export function toNativeView(view: MirrorView) {
  return {
    zoom: view.zoom * 10,
    trimTop: view.trimTop * 10,
    trimBottom: view.trimBottom * 10,
    trimLeft: view.trimLeft * 10,
    trimRight: view.trimRight * 10,
    fit: { auto: 0, fill: 1, fit: 2 }[view.fit],
  };
}
