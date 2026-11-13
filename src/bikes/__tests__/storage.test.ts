jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import AsyncStorage from '@react-native-async-storage/async-storage';

import { emptyLearned } from '../learned';
import { findProfile } from '../profiles';
import {
  forgetLearnedBike,
  loadCustomProfiles,
  loadLearnedBike,
  loadLearnedBikes,
  removeCustomProfile,
  saveCustomProfile,
  saveLearnedBike,
} from '../storage';

beforeEach(() => AsyncStorage.clear());

it('saves, loads and forgets learned bikes without losing overlapping writes', async () => {
  await Promise.all([
    saveLearnedBike({ ...emptyLearned('A', 1), modelId: '1' }),
    saveLearnedBike({ ...emptyLearned('B', 2), modelId: '2' }),
  ]);
  expect(Object.keys(await loadLearnedBikes()).sort()).toEqual(['A', 'B']);
  expect((await loadLearnedBike('B'))?.modelId).toBe('2');
  await forgetLearnedBike('A');
  expect(await loadLearnedBike('A')).toBeNull();
});

it('ignores junk in storage', async () => {
  await AsyncStorage.setItem('bikes.learned.v1', '{"x": {"ssid": 5}, "y": "junk"}');
  await AsyncStorage.setItem('bikes.customProfiles.v1', '[{"id": "450mt", "name": "fake"}, 7]');
  expect(await loadLearnedBikes()).toEqual({});
  expect(await loadCustomProfiles()).toEqual([]);
});

it('stores imported profiles by id', async () => {
  const p = { ...findProfile('generic')!, id: 'custom-1', name: 'Shared bike 1', modelIds: ['1'] };
  await saveCustomProfile(p);
  await saveCustomProfile({ ...p, name: 'Renamed' });
  expect((await loadCustomProfiles()).map((x) => x.name)).toEqual(['Renamed']);
  await removeCustomProfile('custom-1');
  expect(await loadCustomProfiles()).toEqual([]);
});
