/**
 * What the lock-screen ride activity shows, derived from app state. Pure.
 */
import type { LinkState } from '../protocol/session';

export type ActivityLink = 'searching' | 'connecting' | 'onDash' | 'off';

export interface ActivityState {
  linkState: ActivityLink;
  mirroring: boolean;
  speed: number | null;
  speedUnit: string;
  tripText: string;
  trackTitle: string | null;
}

const KM_TO_MI = 0.621371;

export function activityLink(state: LinkState): ActivityLink {
  switch (state) {
    case 'idle':
      return 'off';
    case 'searching':
      return 'searching';
    case 'negotiated':
    case 'streaming':
      return 'onDash';
    default:
      return 'connecting';
  }
}

export function activityState(input: {
  link: LinkState;
  mirroring: boolean;
  speedKmh: number | null;
  tripKm: number;
  imperial: boolean;
  trackTitle: string | null;
}): ActivityState {
  const factor = input.imperial ? KM_TO_MI : 1;
  return {
    linkState: activityLink(input.link),
    mirroring: input.mirroring,
    speed: input.speedKmh === null ? null : Math.round(input.speedKmh * factor),
    speedUnit: input.imperial ? 'mph' : 'km/h',
    tripText: `${(input.tripKm * factor).toFixed(1)} ${input.imperial ? 'mi' : 'km'}`,
    trackTitle: input.trackTitle,
  };
}

/** The activity is shown from the moment the rider connects until they disconnect. */
export function shouldShowActivity(link: LinkState, mirroring: boolean): boolean {
  return link !== 'idle' || mirroring;
}
