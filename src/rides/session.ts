/**
 * The app's one ride recorder plus the saved-ride list, as a tiny external
 * store. Kept apart from src/app-state so the ride log can be wired in (or
 * left out) with two lines: feed samples in, mount the screen.
 */
import { useEffect, useSyncExternalStore } from 'react';

import type { MetricsSample } from '../metrics/trip';
import { type LiveRide, RideRecorder, type RideSummary } from './recorder';
import { addRideToService } from './serviceStore';
import { shareRideGpx, type ShareResult } from './share';
import * as storage from './storage';

export interface RidesState {
  /** Live totals while recording; null when not recording. */
  recording: LiveRide | null;
  /** Saved rides, newest first. */
  rides: RideSummary[];
  /** False until the saved list has been read once. */
  loaded: boolean;
}

export type StopResult =
  | { saved: true; ride: RideSummary; evicted: number }
  /** No usable GPS fixes between Record and Stop, so there is no track to keep. */
  | { saved: false; reason: 'no-track' | 'not-recording' };

const recorder = new RideRecorder();
let state: RidesState = { recording: null, rides: [], loaded: false };
const listeners = new Set<() => void>();

function set(next: Partial<RidesState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function getRidesState(): RidesState {
  return state;
}

export function subscribeRides(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The one entry point from the GPS pipeline. Cheap when not recording: the
 * recorder drops the sample before doing any work, and no listener fires.
 */
export function feedSample(sample: MetricsSample): void {
  if (!recorder.add(sample)) return;
  set({ recording: recorder.live() });
}

export function isRecording(): boolean {
  return recorder.isRecording();
}

/** Only ever called from the rider's Record press. Nothing starts a ride on its own. */
export function startRecording(now: number = Date.now()): void {
  if (recorder.isRecording()) return;
  recorder.start(now);
  set({ recording: recorder.live() });
}

export async function stopRecording(now: number = Date.now()): Promise<StopResult> {
  const ride = recorder.stop(now);
  set({ recording: null });
  if (!ride) return { saved: false, reason: 'not-recording' };
  // A single point is no track: nothing to draw, nothing a GPX reader can use.
  if (ride.points.length < 2) return { saved: false, reason: 'no-track' };
  const evicted = await storage.saveRide(ride);
  await refreshRides();
  // Service reminders count the ride's distance. A failure here must not turn
  // a saved ride into a "could not save" error, so it is swallowed.
  try {
    await addRideToService(ride.summary.id, ride.summary.distanceM);
  } catch {
    // The rider can still add the distance by hand.
  }
  return { saved: true, ride: ride.summary, evicted: evicted.length };
}

export async function refreshRides(): Promise<void> {
  try {
    set({ rides: await storage.listRides(), loaded: true });
  } catch {
    // Storage unreadable: show an empty list rather than a spinner forever.
    set({ loaded: true });
  }
}

export async function deleteSavedRide(id: string): Promise<void> {
  await storage.deleteRide(id);
  await refreshRides();
}

/** Throws if the ride can no longer be read, so the screen can say so. */
export async function exportRide(id: string): Promise<ShareResult> {
  const ride = await storage.loadRide(id);
  if (!ride) throw new Error('This ride could not be read.');
  return shareRideGpx(ride);
}

/** Screen-side view of the ride log. Loads the saved list on first use. */
export function useRides() {
  const snapshot = useSyncExternalStore(subscribeRides, getRidesState);
  useEffect(() => {
    if (!getRidesState().loaded) void refreshRides();
  }, []);
  return {
    ...snapshot,
    start: startRecording,
    stop: stopRecording,
    remove: deleteSavedRide,
    exportGpx: exportRide,
    refresh: refreshRides,
  };
}

/** Test hook: forget the recording and the cached list. */
export function resetRidesForTests(): void {
  recorder.discard();
  state = { recording: null, rides: [], loaded: false };
}
