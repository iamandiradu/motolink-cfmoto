/**
 * Keeps the last few JavaScript errors across restarts, so a crash on the road
 * can be reported after the ride. Wraps the React Native global error handler
 * and, where the runtime offers it, unhandled promise rejections.
 *
 * Nothing here may throw: a crash logger that crashes hides the first error.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { redactText } from './report';

export const CRASH_KEY = 'diagnostics.crashes';
export const MAX_CRASHES = 5;
const MAX_STACK_LINES = 12;
const MAX_MESSAGE = 500;
/** How long a fatal error waits for the write before the previous handler runs. */
const FATAL_WRITE_WAIT_MS = 400;

export interface CrashRecord {
  /** Epoch ms. */
  t: number;
  message: string;
  /** Trimmed to the first lines, null when the error had none. */
  stack: string | null;
  fatal: boolean;
  source: 'error' | 'promise';
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler | null | undefined;
  setGlobalHandler(handler: GlobalHandler): void;
}

interface RejectionTracker {
  enablePromiseRejectionTracker?(options: {
    allRejections: boolean;
    onUnhandled: (id: number, error: unknown) => void;
    onHandled: (id: number) => void;
  }): void;
}

function toRecord(error: unknown, fatal: boolean, source: CrashRecord['source'], now = Date.now()): CrashRecord {
  let message = 'Unknown error';
  let stack: string | null = null;
  try {
    if (error instanceof Error) {
      message = `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}`;
      stack = typeof error.stack === 'string' ? error.stack : null;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error && typeof error === 'object' && 'message' in error) {
      message = String((error as { message: unknown }).message);
    } else {
      message = String(error);
    }
  } catch {
    // Keep the defaults.
  }
  if (stack) {
    stack = stack
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== message && !line.endsWith(`: ${message}`))
      .slice(0, MAX_STACK_LINES)
      .join('\n');
    if (!stack) stack = null;
  }
  return { t: now, message: message.slice(0, MAX_MESSAGE), stack, fatal, source };
}

function isRecord(value: unknown): value is CrashRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.t === 'number' &&
    typeof v.message === 'string' &&
    (v.stack === null || typeof v.stack === 'string') &&
    typeof v.fatal === 'boolean'
  );
}

/** Saved crashes, oldest first. Resolves [] when nothing is saved or storage fails. */
export async function loadCrashes(): Promise<CrashRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(CRASH_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord).map((c) => ({ ...c, source: c.source === 'promise' ? 'promise' : 'error' }));
  } catch {
    return [];
  }
}

export async function clearCrashes(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CRASH_KEY);
  } catch {
    // Nothing to do.
  }
}

/** Writes are chained so two errors in a row do not overwrite each other. */
let writes: Promise<void> = Promise.resolve();

/** Saves one error. Resolves once written (or once writing has failed). Never rejects. */
export function recordCrash(error: unknown, fatal = false, source: CrashRecord['source'] = 'error'): Promise<void> {
  try {
    const crash = toRecord(error, fatal, source);
    writes = writes
      .then(async () => {
        const saved = await loadCrashes();
        await AsyncStorage.setItem(CRASH_KEY, JSON.stringify([...saved, crash].slice(-MAX_CRASHES)));
      })
      .catch(() => undefined);
    return writes;
  } catch {
    return Promise.resolve();
  }
}

let uninstallCurrent: (() => void) | null = null;

/**
 * Installs the handlers once. Returns a function that puts the previous ones
 * back (used by tests). Never throws.
 */
export function installCrashHandler(): () => void {
  if (uninstallCurrent) return uninstallCurrent;
  const undo: (() => void)[] = [];
  try {
    const g = globalThis as unknown as {
      ErrorUtils?: ErrorUtilsLike;
      HermesInternal?: RejectionTracker;
      addEventListener?: (type: string, listener: (event: unknown) => void) => void;
      removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
      __DEV__?: boolean;
    };

    const utils = g.ErrorUtils;
    if (utils && typeof utils.getGlobalHandler === 'function' && typeof utils.setGlobalHandler === 'function') {
      const previous = utils.getGlobalHandler();
      const handler: GlobalHandler = (error, isFatal) => {
        const fatal = !!isFatal;
        let written: Promise<void> = Promise.resolve();
        try {
          written = recordCrash(error, fatal, 'error');
        } catch {
          // Fall through to the previous handler.
        }
        const callPrevious = () => {
          if (typeof previous === 'function') previous(error, isFatal);
        };
        if (!fatal) {
          callPrevious();
          return;
        }
        // A fatal error ends the app: give the write a moment first.
        let called = false;
        const once = () => {
          if (called) return;
          called = true;
          callPrevious();
        };
        const timer = setTimeout(once, FATAL_WRITE_WAIT_MS);
        void written.then(() => {
          clearTimeout(timer);
          once();
        });
      };
      utils.setGlobalHandler(handler);
      undo.push(() => {
        if (previous) utils.setGlobalHandler(previous);
      });
    }

    // Unhandled promise rejections. Hermes first: React Native leaves its
    // tracker off in release builds. In development React Native installs its
    // own for LogBox, so leave that one alone.
    if (typeof g.HermesInternal?.enablePromiseRejectionTracker === 'function') {
      if (g.__DEV__ !== true) {
        g.HermesInternal.enablePromiseRejectionTracker({
          allRejections: true,
          onUnhandled: (_id, error) => void recordCrash(error, false, 'promise'),
          onHandled: () => undefined,
        });
      }
    } else if (typeof g.addEventListener === 'function') {
      const listener = (event: unknown) => {
        const reason = event && typeof event === 'object' && 'reason' in event ? (event as { reason: unknown }).reason : event;
        void recordCrash(reason, false, 'promise');
      };
      g.addEventListener('unhandledrejection', listener);
      undo.push(() => g.removeEventListener?.('unhandledrejection', listener));
    }
  } catch {
    // Never throws.
  }
  uninstallCurrent = () => {
    for (const fn of undo.reverse()) {
      try {
        fn();
      } catch {
        // Ignore.
      }
    }
    uninstallCurrent = null;
  };
  return uninstallCurrent;
}

/** Short, redacted text for the shared report. */
export function formatCrashes(crashes: readonly CrashRecord[], secrets: readonly string[] = []): string {
  try {
    if (crashes.length === 0) return 'Crashes: none saved';
    const lines = [`Crashes (last ${crashes.length})`];
    for (const crash of crashes) {
      const when = new Date(crash.t).toISOString();
      const kind = crash.fatal ? 'fatal' : crash.source === 'promise' ? 'unhandled promise' : 'error';
      lines.push(`  ${when} ${kind}: ${redactText(crash.message, secrets)}`);
      if (crash.stack) {
        for (const line of crash.stack.split('\n').slice(0, 5)) lines.push(`    ${redactText(line, secrets)}`);
      }
    }
    return lines.join('\n');
  } catch {
    return 'Crashes: could not be read';
  }
}
