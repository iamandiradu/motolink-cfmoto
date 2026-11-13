/**
 * Handlebar buttons. They never travel over the Wi-Fi link: the dash sends
 * them to the paired phone as Bluetooth AVRCP, in two shapes:
 *
 *   - an absolute-volume change (the up/down rocker). No key event exists,
 *     only the direction and size of the jump. A double tap arrives as one
 *     bigger jump.
 *   - a transport key: play/pause (select), next, previous.
 *
 * This file turns those raw events into named gestures.
 */

export type RawButtonEvent =
  /** System volume moved; delta is on a 0..1 scale. */
  | { type: 'volume'; delta: number }
  | { type: 'key'; key: 'playPause' | 'next' | 'previous' };

export const GESTURES = [
  'upPress',
  'upDouble',
  'downPress',
  'downDouble',
  'selectPress',
  'nextPress',
  'nextDouble',
  'previousPress',
  'previousDouble',
] as const;

export type Gesture = (typeof GESTURES)[number];

export const GESTURE_LABELS: Record<Gesture, string> = {
  upPress: 'Up',
  upDouble: 'Up ×2',
  downPress: 'Down',
  downDouble: 'Down ×2',
  selectPress: 'Select / Enter',
  nextPress: 'Next (or hold Up)',
  nextDouble: 'Next ×2',
  previousPress: 'Previous (or hold Down)',
  previousDouble: 'Previous ×2',
};

export interface GestureTiming {
  /** Two transport keys inside this window form a double tap. */
  doubleTapMs: number;
  /** Play/pause repeats faster than this are bounces. */
  selectDebounceMs: number;
  /** Volume jump at or above this share of full scale is a double tap. */
  volumeDoubleDelta: number;
  /** Volume jump above this is not a button (slider drag, call, Bluetooth drop). */
  volumeIgnoreDelta: number;
  /** Jumps below this are noise. */
  volumeMinDelta: number;
}

export const DEFAULT_TIMING: GestureTiming = {
  doubleTapMs: 400,
  selectDebounceMs: 150,
  volumeDoubleDelta: 0.12,
  volumeIgnoreDelta: 0.28,
  volumeMinDelta: 0.02,
};

export interface GestureDetectorOptions {
  timing?: Partial<GestureTiming>;
  /**
   * Says whether a double gesture is mapped. When it is not, the single press
   * fires at once instead of waiting out the double-tap window.
   */
  wantsDouble?: (gesture: 'nextDouble' | 'previousDouble') => boolean;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class GestureDetector {
  private readonly timing: GestureTiming;
  private readonly wantsDouble: (gesture: 'nextDouble' | 'previousDouble') => boolean;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private lastSelectAt = -Infinity;
  private pending: { key: 'next' | 'previous'; handle: unknown } | null = null;

  constructor(
    private readonly emit: (gesture: Gesture) => void,
    options: GestureDetectorOptions = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.wantsDouble = options.wantsDouble ?? (() => false);
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  handle(event: RawButtonEvent): void {
    if (event.type === 'volume') this.onVolume(event.delta);
    else if (event.key === 'playPause') this.onSelect();
    else this.onTrack(event.key);
  }

  dispose(): void {
    if (this.pending) this.cancel(this.pending.handle);
    this.pending = null;
  }

  private onVolume(delta: number): void {
    const size = Math.abs(delta);
    if (size < this.timing.volumeMinDelta || size > this.timing.volumeIgnoreDelta) return;
    const double = size >= this.timing.volumeDoubleDelta;
    if (delta > 0) this.emit(double ? 'upDouble' : 'upPress');
    else this.emit(double ? 'downDouble' : 'downPress');
  }

  private onSelect(): void {
    const now = this.now();
    if (now - this.lastSelectAt < this.timing.selectDebounceMs) return;
    this.lastSelectAt = now;
    this.emit('selectPress');
  }

  private onTrack(key: 'next' | 'previous'): void {
    const single: Gesture = key === 'next' ? 'nextPress' : 'previousPress';
    const double = key === 'next' ? 'nextDouble' : 'previousDouble';

    if (this.pending) {
      const first = this.pending;
      this.cancel(first.handle);
      this.pending = null;
      if (first.key === key) {
        this.emit(double);
        return;
      }
      this.emit(first.key === 'next' ? 'nextPress' : 'previousPress');
    }

    if (!this.wantsDouble(double)) {
      this.emit(single);
      return;
    }
    const handle = this.schedule(() => {
      this.pending = null;
      this.emit(single);
    }, this.timing.doubleTapMs);
    this.pending = { key, handle };
  }
}
