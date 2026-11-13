/**
 * Picks the bike profile that fits what we know so far. Evidence arrives in
 * stages: the pairing QR (model id, Wi-Fi kind), then the dash's CLIENT_INFO
 * (software version, touch), then CONFIG_CAPTURE (panel size). The match is
 * recomputed at each stage and gets more confident as evidence piles up.
 *
 * Scoring, not a lookup table, because a model id is shared (37426) or
 * unknown (450 MT), and a hardware fact such as the Wi-Fi kind must be able
 * to overrule a model id the 450 MT might share with the 450SR.
 */
import type { BikeCredentials } from '../protocol/qr';
import { isWifiDirect } from '../protocol/qr';
import type { SessionSnapshot } from '../protocol/session';
import { LearnedBike } from './learned';
import { BIKE_PROFILES, BikeProfile, GENERIC_PROFILE, GENERIC_PROFILE_ID, PanelSize, WifiKind, findProfile, sdkMatches } from './profiles';

export type Confidence = 'certain' | 'likely' | 'guess';

export interface BikeEvidence {
  modelId?: string | null;
  wifi?: WifiKind | null;
  sdkVersion?: string | null;
  /** null when the dash did not say. */
  touch?: boolean | null;
  /** Panel size the dash asked for (deviceWidth/deviceHeight, before rounding). */
  panel?: PanelSize | null;
}

export interface MatchOptions {
  /** The rider's own pick. Always wins. */
  manualId?: string | null;
  profiles?: readonly BikeProfile[];
}

export interface ProfileMatch {
  profile: BikeProfile;
  confidence: Confidence;
  reasons: string[];
  /** Every profile with its score, best first. Excluded profiles are left out. For the log. */
  ranked: { id: string; score: number }[];
}

const W = {
  modelUnique: 10,
  modelShared: 5,
  modelOther: -4,
  wifiMatch: 2,
  touchMatch: 2,
  sdkMatch: 4,
  sdkMismatch: -3,
  panelExact: 8,
  panelMismatch: -6,
  panelHint: 2,
  panelHintMiss: -2,
  /** A guessed field that disagrees: lowers the score instead of excluding. */
  guessMismatch: -2,
} as const;

const CERTAIN = { score: 14, margin: 6 };
const LIKELY = { score: 6, margin: 3 };

/** Wi-Fi kind from the pairing QR, using the same rule the link uses to pick the dash address. */
export function wifiKindOf(creds: Pick<BikeCredentials, 'ssid' | 'action'>): WifiKind {
  return isWifiDirect(creds) ? 'p2p' : 'ap';
}

/**
 * Builds evidence from everything available. The live session beats the
 * learned record, which beats nothing: an earlier ride's panel size still
 * helps before this ride's CONFIG_CAPTURE arrives.
 */
export function evidenceFrom(input: {
  credentials?: Pick<BikeCredentials, 'ssid' | 'action' | 'modelId'> | null;
  snapshot?: SessionSnapshot | null;
  learned?: LearnedBike | null;
}): BikeEvidence {
  const { credentials, snapshot, learned } = input;
  const dash = snapshot?.dash ?? null;
  const rawTouch = dash?.raw.supportScreenTouch;
  const liveTouch = typeof rawTouch === 'boolean' ? rawTouch : dash?.supportScreenTouch ? true : null;
  const capture = snapshot?.capture ?? learned?.capture ?? null;
  return {
    modelId: credentials?.modelId ?? learned?.modelId ?? null,
    wifi: credentials ? wifiKindOf(credentials) : null,
    sdkVersion: dash?.sdkVersion ?? learned?.sdkVersion ?? null,
    touch: liveTouch ?? learned?.supportScreenTouch ?? null,
    panel: capture ? { width: capture.deviceWidth, height: capture.deviceHeight } : null,
  };
}

interface Scored {
  profile: BikeProfile;
  score: number;
  reasons: string[];
  /** Why a recorded fact rules this profile out; empty when it is still possible. */
  excludedBy: string[];
}

const label = (p: BikeProfile) => p.name.replace(/^CFMOTO /, '');
const size = (p: PanelSize) => `${p.width}x${p.height}`;

function scoreProfile(profile: BikeProfile, ev: BikeEvidence, all: readonly BikeProfile[]): Scored {
  const s: Scored = { profile, score: 0, reasons: [], excludedBy: [] };
  const guessed = (field: BikeProfile['guessed'][number]) => profile.guessed.includes(field);
  // A recorded fact that disagrees rules the profile out; a guess only costs points.
  const contradict = (field: BikeProfile['guessed'][number], why: string) => {
    if (guessed(field)) {
      s.score += W.guessMismatch;
      s.reasons.push(`${why} (a guess)`);
    } else {
      s.excludedBy.push(why);
    }
  };

  if (ev.modelId && profile.modelIds.length > 0) {
    if (profile.modelIds.includes(ev.modelId)) {
      const sharing = all.filter((p) => p.modelIds.includes(ev.modelId!));
      if (sharing.length > 1) {
        s.score += W.modelShared;
        s.reasons.push(`model id ${ev.modelId} is shared by ${sharing.map(label).join(', ')}`);
      } else {
        s.score += W.modelUnique;
        s.reasons.push(`model id ${ev.modelId} is the ${label(profile)}`);
      }
    } else {
      // Not a hard rule-out: other markets use other ids for the same bike (800NK).
      s.score += W.modelOther;
    }
  }

  if (ev.wifi && profile.wifi) {
    if (ev.wifi === profile.wifi) {
      s.score += W.wifiMatch;
      s.reasons.push(ev.wifi === 'ap' ? 'Wi-Fi access point fits' : 'Wi-Fi Direct fits');
    } else {
      contradict('wifi', ev.wifi === 'ap' ? 'dash Wi-Fi is an access point' : 'dash Wi-Fi is Wi-Fi Direct');
    }
  }

  if (ev.touch != null && profile.touch != null) {
    if (ev.touch === profile.touch) {
      s.score += W.touchMatch;
      s.reasons.push(ev.touch ? 'touch screen fits' : 'no touch screen fits');
    } else {
      contradict('touch', ev.touch ? 'dash has touch' : 'dash has no touch');
    }
  }

  if (ev.sdkVersion && profile.sdkPrefixes.length > 0) {
    if (profile.sdkPrefixes.some((prefix) => sdkMatches(prefix, ev.sdkVersion!))) {
      s.score += W.sdkMatch;
      s.reasons.push(`dash software ${ev.sdkVersion} fits`);
    } else {
      // Firmware updates change the version, so this never rules a bike out.
      s.score += W.sdkMismatch;
    }
  }

  if (ev.panel) {
    if (profile.panel) {
      if (profile.panel.width === ev.panel.width && profile.panel.height === ev.panel.height) {
        s.score += W.panelExact;
        s.reasons.push(`panel ${size(ev.panel)} fits`);
      } else {
        s.score += W.panelMismatch;
      }
    } else if (profile.panelWidthHint) {
      const landscape = ev.panel.width > ev.panel.height;
      if (landscape && ev.panel.width === profile.panelWidthHint) {
        s.score += W.panelHint;
        s.reasons.push(`panel ${size(ev.panel)} is ${profile.panelWidthHint} wide, as expected`);
      } else {
        s.score += W.panelHintMiss;
      }
    }
  }

  return s;
}

function confidenceOf(score: number, margin: number): Confidence {
  if (score >= CERTAIN.score && margin >= CERTAIN.margin) return 'certain';
  if (score >= LIKELY.score && margin >= LIKELY.margin) return 'likely';
  return 'guess';
}

export function matchProfile(ev: BikeEvidence, options: MatchOptions = {}): ProfileMatch {
  const profiles = options.profiles ?? BIKE_PROFILES;
  const generic = findProfile(GENERIC_PROFILE_ID, profiles) ?? GENERIC_PROFILE;

  const manual = findProfile(options.manualId, profiles);
  if (manual) {
    return { profile: manual, confidence: 'certain', reasons: ['chosen by you'], ranked: [{ id: manual.id, score: 0 }] };
  }

  const scored = profiles.filter((p) => p.id !== generic.id).map((p) => scoreProfile(p, ev, profiles));
  const possible = scored.filter((s) => s.excludedBy.length === 0).sort((a, b) => b.score - a.score);
  const ranked = possible.map((s) => ({ id: s.profile.id, score: s.score }));

  const best = possible[0];
  // Nothing points anywhere (or everything points away): admit it.
  if (!best || best.score <= 0) {
    const reasons = ev.modelId ? [`model id ${ev.modelId} is not known`] : ['nothing known about this bike yet'];
    if (best === undefined && scored.length > 0) reasons.push('no profile fits what the dash reported');
    return { profile: generic, confidence: 'guess', reasons, ranked };
  }

  const runnerUp = possible[1]?.score ?? 0;
  const margin = best.score - Math.max(runnerUp, 0);
  const reasons = [...best.reasons];
  if (possible[1] && possible[1].score === best.score) {
    reasons.push(`could also be the ${label(possible[1].profile)}`);
  }
  // Say why a profile the model id pointed at was dropped; that is the surprising case.
  for (const s of scored) {
    if (s.excludedBy.length > 0 && ev.modelId && s.profile.modelIds.includes(ev.modelId)) {
      reasons.push(`not the ${label(s.profile)}: ${s.excludedBy[0]}`);
    }
  }
  return { profile: best.profile, confidence: confidenceOf(best.score, margin), reasons, ranked };
}
