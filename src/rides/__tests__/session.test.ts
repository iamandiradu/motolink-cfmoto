import { feedSample, getRidesState, isRecording, resetRidesForTests, startRecording, stopRecording } from '../session';
import { listRides } from '../storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
// Sharing is not exercised here; keep the native modules out of the test.
jest.mock('../share', () => ({ shareRideGpx: jest.fn() }));

const T0 = Date.UTC(2026, 10, 13, 8, 0, 0);
const fix = (i: number) => ({ timestamp: T0 + i * 1000, latitude: 45 + i * 0.0003, longitude: 7, speedKmh: 50, accuracyM: 5 });

beforeEach(() => resetRidesForTests());

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
});
