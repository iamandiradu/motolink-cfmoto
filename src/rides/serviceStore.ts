/**
 * Service reminders: AsyncStorage persistence plus a tiny external store, the
 * same shape as the ride session. Updates run one at a time so a ride saved
 * while the rider taps "Done" cannot lose either change.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import * as service from './service';
import type { ServiceState } from './service';

export const SERVICE_KEY = 'motolink.service.v1';

export async function loadServiceState(): Promise<ServiceState> {
  try {
    const raw = await AsyncStorage.getItem(SERVICE_KEY);
    return service.parseServiceState(raw === null ? null : JSON.parse(raw));
  } catch {
    return service.defaultServiceState();
  }
}

export async function saveServiceState(state: ServiceState): Promise<void> {
  await AsyncStorage.setItem(SERVICE_KEY, JSON.stringify(state));
}

export interface ServiceStoreState {
  service: ServiceState;
  loaded: boolean;
}

let snapshot: ServiceStoreState = { service: service.defaultServiceState(), loaded: false };
const listeners = new Set<() => void>();

function publish(next: ServiceStoreState): void {
  snapshot = next;
  listeners.forEach((l) => l());
}

export function getServiceSnapshot(): ServiceStoreState {
  return snapshot;
}

export function subscribeService(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Applies one change: read the stored state, change it, write it back, publish.
 * Always reads from storage first so a change never starts from a stale copy.
 */
export function updateService(change: (s: ServiceState) => ServiceState): Promise<ServiceState> {
  const job = async () => {
    const current = await loadServiceState();
    const next = change(current);
    if (next !== current) await saveServiceState(next);
    publish({ service: next, loaded: true });
    return next;
  };
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

export function refreshService(): Promise<ServiceState> {
  return updateService((s) => s);
}

/** Counts a saved ride towards every service item. Safe to call twice for the same ride. */
export function addRideToService(rideId: string, distanceM: number): Promise<ServiceState> {
  return updateService((s) => service.addRide(s, rideId, distanceM));
}

export function addServiceDistance(km: number): Promise<ServiceState> {
  return updateService((s) => service.addDistance(s, km));
}

export function setServiceOdometer(km: number): Promise<ServiceState> {
  return updateService((s) => service.setOdometer(s, km));
}

export function markServiceDone(id: string): Promise<ServiceState> {
  return updateService((s) => service.markDone(s, id));
}

export function setServiceItemInterval(id: string, intervalKm: number): Promise<ServiceState> {
  return updateService((s) => service.setServiceInterval(s, id, intervalKm));
}

export function resetServiceForTests(): void {
  snapshot = { service: service.defaultServiceState(), loaded: false };
  queue = Promise.resolve();
}

export function useService() {
  const state = useSyncExternalStore(subscribeService, getServiceSnapshot);
  useEffect(() => {
    if (!getServiceSnapshot().loaded) void refreshService();
  }, []);
  return {
    ...state,
    statuses: service.serviceStatuses(state.service),
    addDistance: addServiceDistance,
    setOdometer: setServiceOdometer,
    markDone: markServiceDone,
    setInterval: setServiceItemInterval,
  };
}
