/**
 * App state: one small external store, read with useAppState(selector).
 * Bike credentials, settings and the button layout are persisted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { Gesture, RawButtonEvent } from '../buttons/gestures';
import { ButtonLayout, DEFAULT_LAYOUT, normaliseLayout } from '../buttons/mapping';
import { DashState, INITIAL_DASH_STATE } from '../dash/controller';
import { EMPTY_METRICS, Metrics } from '../metrics/trip';
import type { BikeCredentials } from '../protocol/qr';
import type { SessionSnapshot } from '../protocol/session';

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
  /** 0 for older dashes, 128 for newer ones. Change it if the dash connects but never shows a picture. */
  supportFunction: 0 | 128;
  units: 'metric' | 'imperial';
  /** Bluetooth name of the bike, as iOS lists it. null until the rider picks it. */
  bikeBluetooth: string | null;
  /** Offer mirroring as soon as that Bluetooth device connects. */
  autoStart: boolean;
  /** Mirrored picture: zoom and edge trims in percent, and how it is fitted to the dash. */
  mirrorView: MirrorView;
  /** Ids of explanation cards the rider has closed. */
  dismissedHints: string[];
}

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

export const DEFAULT_SETTINGS: Settings = {
  autoConnect: true,
  buttonMode: 'volume',
  pinVolume: true,
  bitrateKbps: 1500,
  identityOs: 'Android',
  supportFunction: 0,
  units: 'metric',
  bikeBluetooth: null,
  autoStart: true,
  mirrorView: DEFAULT_MIRROR_VIEW,
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
  const source = stored && typeof stored === 'object' ? (stored as Partial<Settings>) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    mirrorView: { ...DEFAULT_MIRROR_VIEW, ...(source.mirrorView ?? {}) },
    dismissedHints: Array.isArray(source.dismissedHints) ? source.dismissedHints : [],
  };
}

export async function loadPersisted(): Promise<void> {
  const [bike, settings, layout] = await Promise.all([read(KEYS.bike), read(KEYS.settings), read(KEYS.layout)]);
  const validBike =
    bike && typeof bike === 'object' && typeof (bike as BikeCredentials).ssid === 'string'
      ? (bike as BikeCredentials)
      : null;
  setState({
    loaded: true,
    bike: validBike,
    settings: mergeSettings(settings),
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
