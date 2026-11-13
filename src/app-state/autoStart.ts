/**
 * Decides what to do when the set of connected Bluetooth devices changes.
 * Pure, so the rules can be tested without a phone.
 *
 * iOS allows no app to start a screen broadcast by itself: the rider must tap
 * Start Broadcast. So the most the app can do is bring that sheet up, or post
 * a notification when it is in the background.
 */

export interface AutoStartInput {
  /** Bluetooth name the rider marked as the bike. */
  bike: string | null;
  enabled: boolean;
  previous: readonly string[];
  current: readonly string[];
  mirroring: boolean;
  appActive: boolean;
}

export type AutoStartStep =
  /** Start (or keep) looking for the dash. */
  | 'connect'
  /** Open the Start Broadcast sheet. */
  | 'showPicker'
  /** App is in the background: tell the rider, and open the sheet when they return. */
  | 'notify';

export function bikeConnected(bike: string | null, outputs: readonly string[]): boolean {
  return bike !== null && outputs.includes(bike);
}

/** Steps to take for one change of Bluetooth outputs. Empty when nothing is due. */
export function onBluetoothChange(input: AutoStartInput): AutoStartStep[] {
  if (!input.enabled || !input.bike) return [];
  const was = bikeConnected(input.bike, input.previous);
  const is = bikeConnected(input.bike, input.current);
  if (was || !is) return [];
  const steps: AutoStartStep[] = ['connect'];
  if (!input.mirroring) steps.push(input.appActive ? 'showPicker' : 'notify');
  return steps;
}
