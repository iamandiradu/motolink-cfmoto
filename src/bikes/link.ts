/**
 * What the link should do differently for a given bike. Kept to overrides so
 * the caller layers them over its own settings and DEFAULT_OPTIONS.
 */
import type { PhoneIdentity } from '../protocol/control';
import type { SessionOptions } from '../protocol/session';
import { LearnedBike, workingIdentity } from './learned';
import { BikeProfile } from './profiles';

export interface LinkOverrides {
  identity: Partial<Pick<PhoneIdentity, 'phoneOs' | 'phoneType' | 'supportFunction'>>;
  options: Partial<Omit<SessionOptions, 'identity'>>;
  /** learned: this dash showed a picture with these settings before. */
  source: 'learned' | 'profile' | 'none';
  reason: string;
}

/**
 * An identity that already produced a picture on this very dash beats any
 * profile, because profile values for unrecorded bikes are guesses.
 */
export function sessionOptionsFor(profile: BikeProfile, learned: LearnedBike | null): LinkOverrides {
  const worked = workingIdentity(learned);
  if (worked) {
    return {
      identity: { phoneOs: worked.phoneOs, phoneType: worked.phoneOs, supportFunction: worked.supportFunction },
      options: {},
      source: 'learned',
      reason: `worked on this bike: ${worked.phoneOs}, supportFunction ${worked.supportFunction}`,
    };
  }
  if (profile.supportFunction !== null) {
    const guess = profile.guessed.includes('supportFunction');
    return {
      identity: { supportFunction: profile.supportFunction },
      options: {},
      source: 'profile',
      reason: `${profile.name}: supportFunction ${profile.supportFunction}${guess ? ' (a guess)' : ''}`,
    };
  }
  return { identity: {}, options: {}, source: 'none', reason: 'app settings' };
}
