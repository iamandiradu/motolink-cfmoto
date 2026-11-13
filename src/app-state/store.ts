/**
 * App state: one small external store, read with useAppState(selector).
 * Bike credentials, settings and the button layout are persisted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { Gesture, RawButtonEvent } from '../buttons/gestures';
import { ButtonLayout, DEFAULT_LAYOUT, normaliseLayout } from '../buttons/mapping';
import { DashState, DashTheme, INITIAL_DASH_STATE, THEMES } from '../dash/controller';
import { EMPTY_METRICS, Metrics } from '../metrics/trip';
import { MirrorPresets, PresetId, defaultPresets, isPresetId, normalisePresets } from '../mirror/presets';
import type { StripEdge } from '../mirror/strip';
import type { BikeCredentials } from '../protocol/qr';
import type { SessionSnapshot } from '../protocol/session';
import type { Playback } from '../spotify/api';
import type { BikeProfile, LearnedBike, ProfileMatch } from '../bikes';

export interface Settings {
  /** Connect by itself when the app opens and a bike is saved. */
  autoConnect: boolean;
  /** off: buttons ignored. volume: rocker only, music keeps playing. full: rocker and media keys, music pauses. */
  buttonMode: 'off' | 'volume' | 'full';
  /** Put the volume back to mid-scale after each rocker press. */
  pinVolume: boolean;
  bitrateKbps: 800 | 1500 | 2500;
  /** What the app tells the dash it is. Android is the identity known to work. */
  identityOs: 'Android' | 'iOS';
  /** Dash generation flag: 0 for older dashes, 128 for newer ones. auto takes it from the bike profile. */
  supportFunction: 'auto' | 0 | 128;
  units: 'metric' | 'imperial';
  /** Colour theme of the dash picture. */
  dashTheme: DashTheme;
  /** Client ID of the rider's own Spotify developer app. Empty until entered. */
  spotifyClientId: string;
  /** Bluetooth name of the bike, as iOS lists it. null until the rider picks it. */
  bikeBluetooth: string | null;
  /** Offer mirroring as soon as that Bluetooth device connects. */
  autoStart: boolean;
  /** Mirrored picture (crop, zoom, fit), remembered per navigation app. */
  mirrorPresets: MirrorPresets;
  /** Which preset is in use now. */
  mirrorPreset: PresetId;
  /** Split view: an info strip (speed, time, song) beside the mirrored picture. */
  mirrorStrip: StripEdge;
  /** First-run walkthrough: finished or skipped, and where the rider left off. */
  onboardingDone: boolean;
  onboardingStep: string | null;
  /** Ids of explanation cards the rider has closed. */
  dismissedHints: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  autoConnect: true,
  buttonMode: 'volume',
  pinVolume: true,
  bitrateKbps: 1500,
  identityOs: 'Android',
  supportFunction: 'auto',
  units: 'metric',
  dashTheme: 'aurora',
  spotifyClientId: '',
  bikeBluetooth: null,
  autoStart: true,
  mirrorPresets: defaultPresets(),
  mirrorPreset: 'general',
  mirrorStrip: 'bottom',
  onboardingDone: false,
  onboardingStep: null,
  dismissedHints: [],
};

export interface AppState {
  loaded: boolean;
  bike: BikeCredentials | null;
  settings: Settings;
  layout: ButtonLayout;
  link: SessionSnapshot;
  dash: DashState;
  metrics: Metrics;
  logs: string[];
  /** Last raw button event and the gesture it became; shown on the Buttons screen. */
  lastButton: { raw: RawButtonEvent; gesture: Gesture | null; at: number } | null;
  /** The phone screen is being mirrored to the dash instead of the app's own picture. */
  mirroring: boolean;
  /** Bluetooth audio devices the phone is connected to right now. */
  bluetoothOutputs: string[];
  spotify: { connected: boolean; playback: Playback | null; error: string | null };
  /** Which bike profile the paired bike matched, and what its dash reported. */
  bikeMatch: ProfileMatch | null;
  learnedBike: LearnedBike | null;
  customProfiles: BikeProfile[];
}

const IDLE_LINK: SessionSnapshot = {
  state: 'idle',
  dash: null,
  capture: null,
  framesSent: 0,
  framesDropped: 0,
  lastError: null,
};

let state: AppState = {
  loaded: false,
  bike: null,
  settings: DEFAULT_SETTINGS,
  layout: { ...DEFAULT_LAYOUT },
  link: IDLE_LINK,
  dash: INITIAL_DASH_STATE,
  metrics: EMPTY_METRICS,
  logs: [],
  lastButton: null,
  mirroring: false,
  bluetoothOutputs: [],
  spotify: { connected: false, playback: null, error: null },
  bikeMatch: null,
  learnedBike: null,
  customProfiles: [],
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppState<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

const MAX_LOG_LINES = 300;

export function appendLog(message: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  setState({ logs: [...state.logs.slice(-(MAX_LOG_LINES - 1)), `${time} ${message}`] });
}

const KEYS = { bike: 'bike', settings: 'settings', layout: 'layout' } as const;

async function read(key: string): Promise<unknown> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  const job = value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, JSON.stringify(value));
  job.catch(() => undefined);
}

function mergeSettings(stored: unknown): Settings {
  const source = stored && typeof stored === 'object' ? (stored as Partial<Settings> & { mirrorView?: unknown }) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    // `mirrorView` is the single adjustment older versions stored.
    mirrorPresets: normalisePresets(source.mirrorPresets, source.mirrorView),
    mirrorPreset: isPresetId(source.mirrorPreset) ? source.mirrorPreset : 'general',
    dismissedHints: Array.isArray(source.dismissedHints) ? source.dismissedHints : [],
    dashTheme: THEMES.includes(source.dashTheme as DashTheme) ? (source.dashTheme as DashTheme) : DEFAULT_SETTINGS.dashTheme,
  };
}

export async function loadPersisted(): Promise<void> {
  const [bike, settings, layout] = await Promise.all([read(KEYS.bike), read(KEYS.settings), read(KEYS.layout)]);
  const merged = mergeSettings(settings);
  const validBike =
    bike && typeof bike === 'object' && typeof (bike as BikeCredentials).ssid === 'string'
      ? (bike as BikeCredentials)
      : null;
  setState({
    loaded: true,
    bike: validBike,
    settings: merged,
    dash: { ...state.dash, theme: merged.dashTheme },
    layout: normaliseLayout(layout),
  });
}

export function saveBike(bike: BikeCredentials | null): void {
  setState({ bike });
  write(KEYS.bike, bike);
}

export function saveSettings(patch: Partial<Settings>): void {
  const settings = { ...state.settings, ...patch };
  setState({ settings });
  write(KEYS.settings, settings);
}

export function dismissHint(id: string): void {
  if (state.settings.dismissedHints.includes(id)) return;
  saveSettings({ dismissedHints: [...state.settings.dismissedHints, id] });
}

export function restoreHints(): void {
  saveSettings({ dismissedHints: [] });
}

export function saveLayout(layout: ButtonLayout): void {
  setState({ layout });
  write(KEYS.layout, layout);
}
