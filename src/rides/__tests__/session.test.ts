import AsyncStorage from '@react-native-async-storage/async-storage';

import { feedSample, getRidesState, isRecording, resetRidesForTests, startRecording, stopRecording } from '../session';
import { getServiceSnapshot, loadServiceState, resetServiceForTests } from '../serviceStore';
import { listRides } from '../storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
// Sharing is not exercised here; keep the native modules out of the test.
jest.mock('../share', () => ({ shareRideGpx: jest.fn() }));

const T0 = Date.UTC(2026, 10, 13, 8, 0, 0);
const fix = (i: number) => ({ timestamp: T0 + i * 1000, latitude: 45 + i * 0.0003, longitude: 7, speedKmh: 50, accuracyM: 5 });

beforeEach(async () => {
  resetRidesForTests();
  resetServiceForTests();
  await AsyncStorage.clear();
});

describe('ride session', () => {
  it('records nothing until the rider presses Record', async () => {
    for (let i = 0; i < 10; i++) feedSample(fix(i));
    expect(isRecording()).toBe(false);
    expect(getRidesState().recording).toBeNull();
    expect(await stopRecording()).toEqual({ saved: false, reason: 'not-recording' });
    expect(await listRides()).toEqual([]);
  });

  it('saves a recorded ride on Stop', async () => {
    startRecording(T0);
    for (let i = 0; i <= 10; i++) feedSample(fix(i));
    expect(getRidesState().recording!.distanceM).toBeGreaterThan(300);
    const result = await stopRecording(T0 + 10_000);
    expect(result.saved).toBe(true);
    expect(isRecording()).toBe(false);
    expect(getRidesState().rides).toHaveLength(1);
  });

  it('does not save a ride without a track', async () => {
    startRecording(T0);
    expect(await stopRecording(T0 + 5000)).toEqual({ saved: false, reason: 'no-track' });
  });

  it('exposes the auto-pause in the live state', () => {
    startRecording(T0);
    for (let i = 0; i <= 5; i++) feedSample(fix(i));
    expect(getRidesState().recording!.paused).toBe(false);
    for (let i = 6; i <= 20; i++) feedSample({ ...fix(5), timestamp: T0 + i * 1000, speedKmh: 0 });
    expect(getRidesState().recording!.paused).toBe(true);
  });

  it('adds a saved ride to the service reminders once', async () => {
    startRecording(T0);
    for (let i = 0; i <= 10; i++) feedSample(fix(i));
    const result = await stopRecording(T0 + 10_000);
    if (!result.saved) throw new Error('not saved');
    const stored = await loadServiceState();
    expect(stored.countedRideIds).toEqual([result.ride.id]);
    expect(stored.items[0].kmSinceDone).toBeCloseTo(result.ride.distanceM / 1000, 6);
    expect(getServiceSnapshot().service).toEqual(stored);
  });
});
