import {
  STEP_COUNT,
  STEP_IDS,
  STEP_TITLES,
  OnboardingState,
  canAutoAdvance,
  isOnDashNetwork,
  nextStep,
  preconditionMet,
  prevStep,
  progressLabel,
  resolveStep,
  shouldAutoAdvance,
} from '../steps';

const none: OnboardingState = { hasBike: false, onDashNetwork: false, mirroring: false };
const all: OnboardingState = { hasBike: true, onDashNetwork: true, mirroring: true };

describe('onboarding steps', () => {
  it('has seven steps in order, each with a title', () => {
    expect(STEP_IDS).toEqual(['about', 'bluetooth', 'closeApp', 'scan', 'wifi', 'mirror', 'done']);
    expect(STEP_COUNT).toBe(7);
    for (const id of STEP_IDS) expect(STEP_TITLES[id].length).toBeGreaterThan(0);
  });

  it('walks forward and back', () => {
    expect(nextStep('about')).toBe('bluetooth');
    expect(nextStep('mirror')).toBe('done');
    expect(nextStep('done')).toBeNull();
    expect(prevStep('bluetooth')).toBe('about');
    expect(prevStep('about')).toBeNull();
  });

  it('labels progress', () => {
    expect(progressLabel('about')).toBe('Step 1 of 7');
    expect(progressLabel('closeApp')).toBe('Step 3 of 7');
    expect(progressLabel('done')).toBe('Step 7 of 7');
  });

  it('resumes from a saved step and ignores junk', () => {
    expect(resolveStep('wifi')).toBe('wifi');
    expect(resolveStep('nope')).toBe('about');
    expect(resolveStep(null)).toBe('about');
    expect(resolveStep(3)).toBe('about');
  });

  it('treats every state past searching as on the dash network', () => {
    expect(isOnDashNetwork('idle')).toBe(false);
    expect(isOnDashNetwork('searching')).toBe(false);
    expect(isOnDashNetwork('probing')).toBe(true);
    expect(isOnDashNetwork('streaming')).toBe(true);
  });

  it('checks only the steps it can check', () => {
    expect(preconditionMet('about', all)).toBeNull();
    expect(preconditionMet('bluetooth', all)).toBeNull();
    expect(preconditionMet('closeApp', all)).toBeNull();
    expect(preconditionMet('done', all)).toBeNull();
    expect(preconditionMet('scan', none)).toBe(false);
    expect(preconditionMet('scan', { ...none, hasBike: true })).toBe(true);
    expect(preconditionMet('wifi', { ...none, onDashNetwork: true })).toBe(true);
    expect(preconditionMet('mirror', { ...none, mirroring: true })).toBe(true);
  });

  it('auto-advances only checked steps once met, never from the last step', () => {
    expect(canAutoAdvance('scan', none)).toBe(false);
    expect(canAutoAdvance('scan', { ...none, hasBike: true })).toBe(true);
    expect(canAutoAdvance('wifi', { ...none, hasBike: true })).toBe(false);
    expect(canAutoAdvance('about', all)).toBe(false);
    expect(canAutoAdvance('done', all)).toBe(false);
  });

  it('auto-advances on the change only, so Back to a finished step stays put', () => {
    const scanned = { ...none, hasBike: true };
    expect(shouldAutoAdvance('scan', none, scanned)).toBe(true);
    expect(shouldAutoAdvance('scan', scanned, scanned)).toBe(false);
    expect(shouldAutoAdvance('wifi', none, scanned)).toBe(false);
  });
});
