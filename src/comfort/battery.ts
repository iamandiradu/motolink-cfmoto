/**
 * Phone battery level and charging state through expo-battery. The only file
 * in src/comfort that touches expo-battery. Never throws.
 */
import * as Battery from 'expo-battery';

export interface BatteryReading {
  /** 0..1, null when unknown (e.g. the simulator). */
  level: number | null;
  charging: boolean;
}

const toLevel = (value: number): number | null => (Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const isCharging = (state: Battery.BatteryState) =>
  state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;

/**
 * Calls back with the first reading, then on every change. Returns the
 * unsubscribe function.
 */
export function watchBattery(callback: (reading: BatteryReading) => void): () => void {
  let reading: BatteryReading = { level: null, charging: false };
  let stopped = false;
  const subscriptions: { remove(): void }[] = [];
  const emit = (patch: Partial<BatteryReading>) => {
    if (stopped) return;
    reading = { ...reading, ...patch };
    try {
      callback(reading);
    } catch {
      // The listener's own error is not ours to surface here.
    }
  };

  try {
    subscriptions.push(Battery.addBatteryLevelListener(({ batteryLevel }) => emit({ level: toLevel(batteryLevel) })));
    subscriptions.push(Battery.addBatteryStateListener(({ batteryState }) => emit({ charging: isCharging(batteryState) })));
  } catch {
    // No native module: readings stay unknown.
  }

  void (async () => {
    try {
      const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
      emit({ level: toLevel(level), charging: isCharging(state) });
    } catch {
      emit({});
    }
  })();

  return () => {
    stopped = true;
    for (const s of subscriptions) {
      try {
        s.remove();
      } catch {
        // Already gone.
      }
    }
  };
}
