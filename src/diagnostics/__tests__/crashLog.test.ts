import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CRASH_KEY,
  MAX_CRASHES,
  clearCrashes,
  formatCrashes,
  installCrashHandler,
  loadCrashes,
  recordCrash,
} from '../crashLog';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

type Handler = (error: unknown, isFatal?: boolean) => void;

const g = globalThis as unknown as { ErrorUtils?: unknown };
let savedErrorUtils: unknown;

function fakeErrorUtils(previous: Handler) {
  let current: Handler = previous;
  const utils = {
    getGlobalHandler: () => current,
    setGlobalHandler: (h: Handler) => {
      current = h;
    },
  };
  g.ErrorUtils = utils;
  return { fire: (error: unknown, fatal?: boolean) => current(error, fatal) };
}

beforeEach(async () => {
  savedErrorUtils = g.ErrorUtils;
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

afterEach(() => {
  g.ErrorUtils = savedErrorUtils;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('crash log', () => {
  it('stores errors from the global handler and calls the previous one', async () => {
    const previous = jest.fn();
    const utils = fakeErrorUtils(previous);
    const uninstall = installCrashHandler();
    const error = new TypeError('cannot read huid of undefined');
    utils.fire(error, false);
    expect(previous).toHaveBeenCalledWith(error, false);
    await recordCrash('second', false); // waits for the queued write too
    const crashes = await loadCrashes();
    expect(crashes).toHaveLength(2);
    expect(crashes[0]).toMatchObject({ message: 'TypeError: cannot read huid of undefined', fatal: false, source: 'error' });
    expect(crashes[0].stack).toEqual(expect.any(String));
    expect(crashes[0].stack!.split('\n').length).toBeLessThanOrEqual(12);
    uninstall();
  });

  it('a fatal error is written before the previous handler runs', async () => {
    const previous = jest.fn();
    const utils = fakeErrorUtils(previous);
    const uninstall = installCrashHandler();
    utils.fire(new Error('boom'), true);
    expect(previous).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(previous).toHaveBeenCalledTimes(1);
    expect((await loadCrashes())[0]).toMatchObject({ message: 'boom', fatal: true });
    uninstall();
  });

  it('keeps only the last few', async () => {
    for (let i = 0; i < MAX_CRASHES + 3; i++) await recordCrash(new Error(`e${i}`));
    const crashes = await loadCrashes();
    expect(crashes).toHaveLength(MAX_CRASHES);
    expect(crashes[crashes.length - 1].message).toBe(`e${MAX_CRASHES + 2}`);
  });

  it('clears', async () => {
    await recordCrash(new Error('x'));
    await clearCrashes();
    expect(await loadCrashes()).toEqual([]);
    expect(await AsyncStorage.getItem(CRASH_KEY)).toBeNull();
  });

  it('survives garbage in storage', async () => {
    await AsyncStorage.setItem(CRASH_KEY, '{not json');
    expect(await loadCrashes()).toEqual([]);
    await AsyncStorage.setItem(CRASH_KEY, JSON.stringify([{ t: 1 }, { t: 2, message: 'ok', stack: null, fatal: false }]));
    expect(await loadCrashes()).toEqual([{ t: 2, message: 'ok', stack: null, fatal: false, source: 'error' }]);
  });

  it('a throwing storage does not propagate', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('disk full'));
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation(() => {
      throw new Error('disk full');
    });
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValue(new Error('disk full'));
    const previous = jest.fn();
    const utils = fakeErrorUtils(previous);
    const uninstall = installCrashHandler();
    expect(() => utils.fire(new Error('first'), false)).not.toThrow();
    expect(previous).toHaveBeenCalledTimes(1);
    utils.fire(new Error('fatal one'), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(previous).toHaveBeenCalledTimes(2);
    await expect(recordCrash(new Error('x'))).resolves.toBeUndefined();
    await expect(loadCrashes()).resolves.toEqual([]);
    await expect(clearCrashes()).resolves.toBeUndefined();
    await flush();
    uninstall();
  });

  it('installs without ErrorUtils', () => {
    g.ErrorUtils = undefined;
    expect(() => installCrashHandler()()).not.toThrow();
  });

  it('formats short and redacted', () => {
    const text = formatCrashes(
      [
        {
          t: Date.UTC(2026, 10, 13, 9, 0, 0),
          message: 'join failed for CFMOTO-f46457 with hunter2secret, unit HU0123456789ABCDEF00',
          stack: 'at a (index.bundle:1:2)\nat b\nat c\nat d\nat e\nat f\nat g',
          fatal: true,
          source: 'error',
        },
      ],
      ['hunter2secret'],
    );
    expect(text).toContain('2026-11-13T09:00:00.000Z fatal:');
    expect(text).not.toContain('hunter2secret');
    expect(text).not.toContain('f46457');
    expect(text).not.toContain('HU0123456789ABCDEF00');
    expect(text).not.toContain('at f');
    expect(formatCrashes([])).toBe('Crashes: none saved');
  });
});
