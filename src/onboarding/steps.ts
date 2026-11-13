/**
 * First-run onboarding: step order and the pure rules that drive it.
 * No React here, so the logic can be tested on its own.
 */
import { t } from '../i18n';
import type { LinkState } from '../protocol/session';

export const STEP_IDS = ['about', 'bluetooth', 'closeApp', 'scan', 'wifi', 'mirror', 'done'] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Step heading in the current language; read at render time so it follows a change. */
export function stepTitle(step: StepId): string {
  return t(`onboarding.steps.${step}`);
}

/** What the flow knows about the outside world. */
export interface OnboardingState {
  hasBike: boolean;
  onDashNetwork: boolean;
  mirroring: boolean;
}

export const STEP_COUNT = STEP_IDS.length;

export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value);
}

/** Turns a saved value back into a step; unknown or missing values start at the beginning. */
export function resolveStep(saved: unknown): StepId {
  return isStepId(saved) ? saved : STEP_IDS[0];
}

export function stepIndex(step: StepId): number {
  return STEP_IDS.indexOf(step);
}

/** The step after this one, or null on the last step. */
export function nextStep(step: StepId): StepId | null {
  const i = stepIndex(step);
  return i < STEP_COUNT - 1 ? STEP_IDS[i + 1] : null;
}

/** The step before this one, or null on the first step. */
export function prevStep(step: StepId): StepId | null {
  const i = stepIndex(step);
  return i > 0 ? STEP_IDS[i - 1] : null;
}

/** "Step 3 of 7". */
export function progressLabel(step: StepId): string {
  return t('onboarding.progress', { n: stepIndex(step) + 1, total: STEP_COUNT });
}

/** True once the phone has reached the dash network (every state past searching). */
export function isOnDashNetwork(linkState: LinkState): boolean {
  return linkState !== 'idle' && linkState !== 'searching';
}

/**
 * Whether the step's check is met. Null for steps the app cannot check
 * (reading text, pairing Bluetooth, closing another app).
 */
export function preconditionMet(step: StepId, state: OnboardingState): boolean | null {
  switch (step) {
    case 'scan':
      return state.hasBike;
    case 'wifi':
      return state.onDashNetwork;
    case 'mirror':
      return state.mirroring;
    default:
      return null;
  }
}

/**
 * Whether the flow may move on by itself from this step: only steps with a
 * check, and only once it is met. The last step never advances by itself.
 */
export function canAutoAdvance(step: StepId, state: OnboardingState): boolean {
  return nextStep(step) !== null && preconditionMet(step, state) === true;
}

/**
 * Auto-advance only when the check turns true while the rider is on the step,
 * so going Back to a finished step does not bounce them forward again.
 */
export function shouldAutoAdvance(step: StepId, before: OnboardingState, after: OnboardingState): boolean {
  return canAutoAdvance(step, after) && preconditionMet(step, before) !== true;
}
