/**
 * Voice announcements through expo-speech (out through the helmet headset
 * when one is connected). The only file in src/comfort that touches expo-speech.
 * Never throws.
 */
import * as Speech from 'expo-speech';

let enabled = true;
/** Text being spoken now, to drop a repeat that arrives while it is still playing. */
let speaking: string | null = null;

export function setSpeechEnabled(on: boolean): void {
  enabled = on;
  if (!on) stop();
}

export function isSpeechEnabled(): boolean {
  return enabled;
}

/**
 * Speak `text`. Dropped when voice is off or the same text is still being
 * spoken. A different text interrupts nothing: the system queues it.
 * Returns true when the utterance was handed to the system.
 */
export function say(text: string, options: { enabled?: boolean } = {}): boolean {
  const on = options.enabled ?? enabled;
  const trimmed = text.trim();
  if (!on || trimmed.length === 0 || speaking === trimmed) return false;
  try {
    speaking = trimmed;
    const done = () => {
      if (speaking === trimmed) speaking = null;
    };
    Speech.speak(trimmed, { onDone: done, onStopped: done, onError: done });
    return true;
  } catch {
    speaking = null;
    return false;
  }
}

/** Stop speaking and drop anything queued. */
export function stop(): void {
  speaking = null;
  try {
    void Speech.stop().catch(() => undefined);
  } catch {
    // Native module missing (e.g. a test runner): nothing to stop.
  }
}
