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
}

export const DEFAULT_SETTINGS: Settings = {
  autoConnect: true,
  buttonMode: 'volume',
  pinVolume: true,
  bitrateKbps: 1500,
  identityOs: 'Android',
  supportFunction: 0,
  units: 'metric',
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

export async function loadPersisted(): Promise<void> {
  const [bike, settings, layout] = await Promise.all([read(KEYS.bike), read(KEYS.settings), read(KEYS.layout)]);
  const validBike =
    bike && typeof bike === 'object' && typeof (bike as BikeCredentials).ssid === 'string'
      ? (bike as BikeCredentials)
      : null;
  setState({
    loaded: true,
    bike: validBike,
    settings: { ...DEFAULT_SETTINGS, ...(settings && typeof settings === 'object' ? settings : {}) },
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

export function saveLayout(layout: ButtonLayout): void {
  setState({ layout });
  write(KEYS.layout, layout);
}
