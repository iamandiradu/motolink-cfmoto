import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Ride } from '../recorder';
import { INDEX_KEY, POINTS_PREFIX, deleteRide, listRides, loadRide, saveRide } from '../storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function makeRide(id: string, startedAt: number): Ride {
  return {
    summary: {
      id,
      startedAt,
      endedAt: startedAt + 1000,
      distanceM: 10,
      movingSeconds: 1,
      totalSeconds: 1,
      maxSpeedKmh: 36,
      avgSpeedKmh: 36,
      elevationGainM: 0,
      pointCount: 2,
    },
    points: [
      { t: startedAt, lat: 45, lon: 7, ele: 300 },
      { t: startedAt + 1000, lat: 45.0001, lon: 7 },
    ],
  };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('ride storage', () => {
  it('saves, lists newest first, loads and deletes', async () => {
    await saveRide(makeRide('a', 1000));
    await saveRide(makeRide('b', 2000));
    expect((await listRides()).map((r) => r.id)).toEqual(['b', 'a']);

    const loaded = await loadRide('a');
    expect(loaded).toEqual(makeRide('a', 1000));

    await deleteRide('a');
    expect((await listRides()).map((r) => r.id)).toEqual(['b']);
    expect(await loadRide('a')).toBeNull();
    expect(await AsyncStorage.getItem(POINTS_PREFIX + 'a')).toBeNull();
  });

  it('evicts the oldest past the cap', async () => {
    for (let i = 1; i <= 4; i++) await saveRide(makeRide(`r${i}`, i * 1000), 3);
    expect((await listRides()).map((r) => r.id)).toEqual(['r4', 'r3', 'r2']);
    expect(await loadRide('r1')).toBeNull();
  });

  it('serialises concurrent writes', async () => {
    await Promise.all([saveRide(makeRide('x', 1)), saveRide(makeRide('y', 2)), saveRide(makeRide('z', 3))]);
    expect((await listRides()).map((r) => r.id)).toEqual(['z', 'y', 'x']);
  });

  it('survives a corrupt index by rebuilding it from the rides', async () => {
    await saveRide(makeRide('a', 1000));
    await saveRide(makeRide('b', 2000));
    await AsyncStorage.setItem(INDEX_KEY, '{not json');
    await AsyncStorage.setItem(POINTS_PREFIX + 'broken', 'garbage');
    expect((await listRides()).map((r) => r.id)).toEqual(['b', 'a']);
    expect(await AsyncStorage.getItem(POINTS_PREFIX + 'broken')).toBeNull();
  });

  it('drops malformed index entries and unreadable rides', async () => {
    await saveRide(makeRide('a', 1000));
    const index = JSON.parse((await AsyncStorage.getItem(INDEX_KEY))!);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify([...index, { id: 'bad' }, null, 42]));
    expect((await listRides()).map((r) => r.id)).toEqual(['a']);

    await AsyncStorage.setItem(POINTS_PREFIX + 'a', '{"v":1');
    expect(await loadRide('a')).toBeNull();
  });

  it('skips corrupt points inside an otherwise good ride', async () => {
    await saveRide(makeRide('a', 1000));
    const raw = JSON.parse((await AsyncStorage.getItem(POINTS_PREFIX + 'a'))!);
    raw.points.push(['x', 1, 2], [1, 2]);
    await AsyncStorage.setItem(POINTS_PREFIX + 'a', JSON.stringify(raw));
    expect((await loadRide('a'))!.points).toHaveLength(2);
  });
});
