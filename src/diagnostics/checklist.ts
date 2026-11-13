/**
 * Roadside checklist: turns what the app knows about the link into an ordered
 * list of steps a rider can read with the bike running. Pure.
 *
 * The session snapshot is trusted first. Log lines are only read for what the
 * snapshot cannot tell: whether the probe was accepted or refused, whether the
 * dash called back at all, the serial check, the video channel opening and a
 * connect-then-drop loop.
 */
import type { SessionSnapshot, LinkState } from '../protocol/session';
import { redactText } from './report';

export type StepId =
  | 'paired'
  | 'wifi'
  | 'probe'
  | 'callback'
  | 'identity'
  | 'serial'
  | 'picture'
  | 'pulls'
  | 'frames';

export type StepStatus = 'done' | 'active' | 'waiting' | 'failed' | 'skipped';

export interface StepHint {
  /** Most likely causes, most likely first. */
  causes: string[];
  /** What to do, in order. */
  actions: string[];
}

export interface ChecklistStep {
  id: StepId;
  title: string;
  status: StepStatus;
  /** One line. */
  detail: string;
  /** Only on the step where things are stuck. */
  hint?: StepHint;
}

export interface Checklist {
  steps: ChecklistStep[];
  /** The step that is 'active' or 'failed', null when everything is done. */
  stuck: StepId | null;
  /** One short sentence for the top of the card. */
  headline: string;
}

export interface ChecklistInput {
  paired: boolean;
  /** Phone IPv4 on Wi-Fi, null when Wi-Fi has no address. */
  phoneIp: string | null;
  /** Best guess of the dash address. */
  dashAddress: string | null;
  snapshot: Pick<SessionSnapshot, 'state' | 'dash' | 'capture' | 'framesSent' | 'framesDropped' | 'lastError'>;
  mirroring: boolean;
  /** Recent log lines, oldest first, as kept by the app ("HH:MM:SS message"). */
  logs: readonly string[];
  /** Epoch ms. Used to ignore old connect-then-drop cycles. */
  now: number;
}

const RANK: Record<LinkState, number> = {
  idle: 0,
  searching: 1,
  probing: 2,
  waitingForDash: 3,
  handshaking: 4,
  negotiated: 5,
  streaming: 6,
};

const TITLES: Record<StepId, string> = {
  paired: 'Paired with a bike',
  wifi: 'Phone on the dash Wi-Fi',
  probe: 'Dash answered',
  callback: 'Dash called back',
  identity: 'Dash described itself',
  serial: 'Serial check',
  picture: 'Picture size agreed',
  pulls: 'Dash asking for video',
  frames: 'Picture flowing',
};

const HEADLINE_ACTIVE: Record<StepId, string> = {
  paired: 'Pair with the bike to start.',
  wifi: 'Waiting for the phone to join the dash Wi-Fi.',
  probe: 'Asking the dash to connect.',
  callback: 'Waiting for the dash to call back.',
  identity: 'Waiting for the dash to describe itself.',
  serial: 'Waiting for the dash to check the phone.',
  picture: 'Waiting for the dash to agree a picture size.',
  pulls: 'Picture size agreed. Waiting for the dash to ask for video.',
  frames: 'Waiting for the first picture to reach the dash.',
};

const HEADLINE_FAILED: Record<StepId, string> = {
  paired: 'Pair with the bike to start.',
  wifi: 'The phone is not on the dash Wi-Fi.',
  probe: 'The dash did not accept the connection.',
  callback: 'The dash never called back.',
  identity: 'The dash stopped before describing itself.',
  serial: 'The serial check did not pass.',
  picture: 'The dash stopped before agreeing a picture size.',
  pulls: 'The dash agreed a picture but never asked for video.',
  frames: 'The picture stopped reaching the dash.',
};

// ---------------------------------------------------------------------------
// Hints

const HINT_PAIR: StepHint = {
  causes: ['No bike is saved on this phone yet.'],
  actions: [
    'Switch the ignition on, open MotoPlay on the dash and choose the phone connection screen.',
    'Scan the QR code the dash shows.',
  ],
};

function hintNoWifi(joinUnavailable: boolean): StepHint {
  const causes = ['The bike is off, or the phone has not joined the dash Wi-Fi yet.'];
  if (joinUnavailable) causes.push('This copy of MotoLink cannot join Wi-Fi by itself.');
  return {
    causes,
    actions: [
      'Switch the ignition on.',
      'In iOS Settings > Wi-Fi, join the network that starts with CFMOTO or DIRECT-.',
      'Come back to MotoLink. It carries on by itself.',
    ],
  };
}

const HINT_OTHER_WIFI: StepHint = {
  causes: ['The phone is on another Wi-Fi network, such as home or a hotspot.'],
  actions: [
    'In iOS Settings > Wi-Fi, choose the network that starts with CFMOTO or DIRECT-.',
    'If the phone keeps going back to another network, turn off Auto-Join for that one.',
  ],
};

const HINT_PROBE_REFUSED: StepHint = {
  causes: [
    'The CFMOTO app is open on this or another phone and holds the connection.',
    'The dash is not on the MotoPlay phone connection screen.',
  ],
  actions: [
    'Close the CFMOTO app fully (swipe it away), on every phone near the bike.',
    'On the dash, open MotoPlay and choose the phone connection screen.',
    'If it still says no, switch the ignition off and on again.',
  ],
};

const HINT_PROBE_SILENT: StepHint = {
  causes: [
    'The dash is not on the MotoPlay phone connection screen.',
    'The phone is on the dash Wi-Fi but the dash is at another address.',
  ],
  actions: [
    'On the dash, open MotoPlay and choose the phone connection screen.',
    'Turn Wi-Fi off and on in Control Centre, then wait for the phone to rejoin the dash.',
    'If it still fails, share a report from Settings after the ride.',
  ],
};

const HINT_CALLBACK: StepHint = {
  causes: [
    'A VPN is on and sends the traffic away from the dash.',
    'Local Network access for MotoLink is turned off.',
  ],
  actions: [
    'Turn off any VPN (Settings > VPN, or the VPN app).',
    'In Settings > Privacy & Security > Local Network, turn MotoLink on.',
    'Then tap Connect again.',
  ],
};

const HINT_IDENTITY: StepHint = {
  causes: ['The dash opened the link but has not sent its details yet.'],
  actions: ['Wait a few seconds.', 'If it stays here, try the other Dash generation in Settings.'],
};

const HINT_SERIAL: StepHint = {
  causes: ['Some dashes check the phone before they agree a picture.'],
  actions: ['Wait a few seconds.', 'If it stays here, try the other Dash generation in Settings.'],
};

const HINT_PICTURE: StepHint = {
  causes: [
    'The dash has not opened the picture channel yet.',
    'The dash may not accept how the phone introduced itself.',
  ],
  actions: ['Wait a few seconds.', 'If it stays here, try the other Dash generation in Settings.'],
};

const HINT_PULLS: StepHint = {
  causes: ['The dash is showing its own gauges screen, not MotoPlay.'],
  actions: ['On the dash, open MotoPlay. The picture starts as soon as it is on screen.'],
};

function hintFrames(mirroring: boolean): StepHint {
  return {
    causes: mirroring
      ? ['Screen mirroring stopped, or the phone is locked.', 'MotoLink is not open on the phone.']
      : ['MotoLink is not open on screen, or the phone is locked.'],
    actions: mirroring
      ? ['Unlock the phone and check that mirroring is still on.', 'Open MotoLink and keep the phone unlocked.']
      : ['Open MotoLink and keep it on screen with the phone unlocked.'],
  };
}

const HINT_DROP_LOOP: StepHint = {
  causes: ['The dash does not accept the picture size or how the phone introduced itself.'],
  actions: [
    'In Settings, switch to the other Dash generation, then tap Connect again.',
    'If it keeps dropping, share a report from Settings after the ride.',
  ],
};

const HINT_PHONE_KEY: StepHint = {
  causes: ['The phone could not prepare the link.'],
  actions: ['Close MotoLink fully (swipe it away) and open it again.'],
};

// ---------------------------------------------------------------------------
// Log reading

interface Line {
  /** Seconds since local midnight, null when the line has no time. */
  sec: number | null;
  text: string;
}

function parseLine(line: string): Line {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})\s+(.*)$/.exec(line);
  if (!m) return { sec: null, text: line };
  return { sec: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]), text: m[4] };
}

type ProbeResult = 'accepted' | 'rejected' | 'refused' | 'timeout' | 'error';

interface ProbeLine {
  index: number;
  result: ProbeResult;
}

function probeLine(text: string): ProbeResult | null {
  if (/^probe accepted by /.test(text)) return 'accepted';
  if (/^probe rejected by /.test(text)) return 'rejected';
  const m = /^probe \S+ #\d+: (.*)$/.exec(text);
  if (!m) return null;
  if (/refused|reset/i.test(m[1])) return 'refused';
  if (/time ?out|timed out/i.test(m[1])) return 'timeout';
  return 'error';
}

const CONTROL_OPEN = /^dash connected :10922\b/;
const DATA_OPEN = /^dash connected :10920\b/;
const DISCONNECTED = /^dash disconnected\b/;
const SAW_INFO = /^ctrl <- CLIENT_INFO\b/;
const SAW_SN = /^ctrl <- CHECK_SN\b/;
const ASKED = /^dash asked for (\d+)x(\d+)@(\d+)/;

interface Cycle {
  start: number | null;
  end: number | null;
  info: boolean;
  sn: boolean;
  picture: string | null;
}

interface LogFacts {
  lastProbe: ProbeLine | null;
  noCallback: boolean;
  joinUnavailable: boolean;
  /** Since the latest control connection. */
  sawSn: boolean;
  dataOpened: boolean;
  /** Two short connect-then-drop cycles in a row, recently. */
  dropLoop: { cycle: Cycle; seconds: number | null; count: number } | null;
}

const SHORT_CYCLE_SEC = 15;
const RECENT_SEC = 180;

function readLogs(logs: readonly string[], now: number): LogFacts {
  const lines = logs.map(parseLine);
  let lastProbe: ProbeLine | null = null;
  let lastCtrl = -1;
  let noCallbackAt = -1;
  let joinUnavailable = false;
  const cycles: Cycle[] = [];
  let open: Cycle | null = null;

  lines.forEach((line, index) => {
    const { text } = line;
    const probe = probeLine(text);
    if (probe) lastProbe = { index, result: probe };
    if (text === 'dash did not dial back') noCallbackAt = index;
    if (text.startsWith('Wi-Fi join not available')) joinUnavailable = true;
    if (CONTROL_OPEN.test(text)) {
      lastCtrl = index;
      if (!open) open = { start: line.sec, end: null, info: false, sn: false, picture: null };
    }
    if (open) {
      if (SAW_INFO.test(text)) open.info = true;
      if (SAW_SN.test(text)) open.sn = true;
      const asked = ASKED.exec(text);
      if (asked) open.picture = `${asked[1]}x${asked[2]}`;
      if (DISCONNECTED.test(text)) {
        open.end = line.sec;
        cycles.push(open);
        open = null;
      }
    }
  });

  let sawSn = false;
  let dataOpened = false;
  for (let i = Math.max(lastCtrl, 0); i < lines.length; i++) {
    if (SAW_SN.test(lines[i].text)) sawSn = true;
    if (DATA_OPEN.test(lines[i].text)) dataOpened = true;
  }

  const probeAt = (lastProbe as ProbeLine | null)?.index ?? -1;
  return {
    lastProbe,
    noCallback: noCallbackAt > probeAt && probeAt >= 0,
    joinUnavailable,
    sawSn,
    dataOpened,
    dropLoop: findDropLoop(cycles, now),
  };
}

function secondsOfDay(now: number): number {
  const d = new Date(now);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function findDropLoop(cycles: Cycle[], now: number): LogFacts['dropLoop'] {
  if (cycles.length < 2) return null;
  const last = cycles.slice(-2);
  const nowSec = secondsOfDay(now);
  const durations: number[] = [];
  for (const cycle of last) {
    if (cycle.start !== null && cycle.end !== null) {
      const duration = (cycle.end - cycle.start + 86400) % 86400;
      if (duration > SHORT_CYCLE_SEC) return null;
      if ((nowSec - cycle.end + 86400) % 86400 > RECENT_SEC) return null;
      durations.push(duration);
    }
  }
  let count = 0;
  for (let i = cycles.length - 1; i >= 0; i--) {
    const c = cycles[i];
    const d = c.start !== null && c.end !== null ? (c.end - c.start + 86400) % 86400 : null;
    if (d !== null && d > SHORT_CYCLE_SEC) break;
    count++;
  }
  const seconds = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  return { cycle: last[1], seconds, count };
}

// ---------------------------------------------------------------------------
// Steps

type WifiKind = 'hotspot' | 'direct' | 'other' | 'none';

function wifiKind(ip: string | null): WifiKind {
  if (!ip) return 'none';
  if (ip.startsWith('192.168.49.')) return 'direct';
  if (ip.startsWith('192.168.0.')) return 'hotspot';
  return 'other';
}

const WIFI_NAME: Record<'hotspot' | 'direct', string> = {
  hotspot: 'dash hotspot',
  direct: 'dash Wi-Fi Direct network',
};

interface StepDraft {
  id: StepId;
  /** 'done', 'skipped', or not reached yet. */
  reached: 'done' | 'skipped' | false;
  doneDetail: string;
  activeDetail: string;
  activeHint: StepHint;
  /** Set when there is evidence this step failed. */
  failure?: { detail: string; hint: StepHint; headline?: string };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function shortError(error: string): string {
  const clean = redactText(error, []).replace(/\s+/g, ' ').trim();
  return clean.length > 100 ? `${clean.slice(0, 97)}...` : clean;
}

export function buildChecklist(input: ChecklistInput): Checklist {
  const { snapshot } = input;
  const rank = RANK[snapshot.state];
  const facts = readLogs(input.logs, input.now);
  const kind = wifiKind(input.phoneIp);
  const dash = snapshot.dash;
  const version = dash?.sdkVersion ?? (typeof dash?.raw?.version_name === 'string' ? dash.raw.version_name : null);
  const capture = snapshot.capture;
  const dropLoop = snapshot.state !== 'streaming' && !(rank >= 5 && facts.dataOpened) ? facts.dropLoop : null;

  const drafts: StepDraft[] = [];

  drafts.push({
    id: 'paired',
    reached: input.paired ? 'done' : false,
    doneDetail: 'Bike saved on this phone.',
    activeDetail: 'No bike saved yet. Scan the QR code on the dash.',
    activeHint: HINT_PAIR,
  });

  const wifiOk = kind === 'hotspot' || kind === 'direct';
  drafts.push({
    id: 'wifi',
    reached: wifiOk || rank >= RANK.waitingForDash || dropLoop ? 'done' : false,
    doneDetail: wifiOk
      ? `On the ${WIFI_NAME[kind as 'hotspot' | 'direct']} (${input.phoneIp}).`
      : `On the dash network (${input.phoneIp ?? 'address unknown'}).`,
    activeDetail:
      kind === 'none'
        ? 'Wi-Fi has no address yet.'
        : `On another network (${input.phoneIp}). Dash networks use 192.168.0.x or 192.168.49.x.`,
    activeHint: kind === 'other' ? HINT_OTHER_WIFI : hintNoWifi(facts.joinUnavailable),
    failure:
      kind === 'other' && rank > 0
        ? {
            detail: `On another network (${input.phoneIp}). Dash networks use 192.168.0.x or 192.168.49.x.`,
            hint: HINT_OTHER_WIFI,
            headline: 'The phone is on another Wi-Fi network.',
          }
        : undefined,
  });

  const dashAt = input.dashAddress ? ` at ${input.dashAddress}` : '';
  const probe = facts.lastProbe?.result ?? null;
  const probeDone = rank >= RANK.waitingForDash || (rank === RANK.probing && probe === 'accepted') || !!dropLoop;
  let probeFailure: StepDraft['failure'];
  if (probe === 'rejected' || probe === 'refused') {
    probeFailure = {
      detail: probe === 'rejected' ? `The dash${dashAt} said no.` : `The dash${dashAt} refused the connection.`,
      hint: HINT_PROBE_REFUSED,
    };
  } else if (probe === 'timeout' || probe === 'error') {
    probeFailure = { detail: `No answer from the dash${dashAt}.`, hint: HINT_PROBE_SILENT };
  }
  drafts.push({
    id: 'probe',
    reached: probeDone ? 'done' : false,
    doneDetail: `The dash${dashAt} accepted the phone.`,
    activeDetail: rank === 0 ? 'Not connecting. Tap Connect.' : `Asking the dash${dashAt} to connect.`,
    activeHint: HINT_PROBE_SILENT,
    failure: probeFailure,
  });

  drafts.push({
    id: 'callback',
    reached: rank >= RANK.handshaking || dropLoop ? 'done' : false,
    doneDetail: 'The dash opened the control connection.',
    activeDetail: 'Waiting for the dash to connect to the phone.',
    activeHint: HINT_CALLBACK,
    failure:
      facts.noCallback && rank < RANK.waitingForDash
        ? { detail: 'The dash accepted, then never connected to the phone.', hint: HINT_CALLBACK }
        : undefined,
  });

  const identityReached = dropLoop ? dropLoop.cycle.info : rank >= RANK.handshaking && !!dash;
  drafts.push({
    id: 'identity',
    reached: identityReached ? 'done' : false,
    doneDetail: version ? `Dash software ${version}.` : 'The dash sent its details (no version given).',
    activeDetail: 'Waiting for the dash to send its details.',
    activeHint: HINT_IDENTITY,
  });

  const pictureLabel = dropLoop
    ? dropLoop.cycle.picture
    : rank >= RANK.negotiated && capture
      ? `${capture.deviceWidth}x${capture.deviceHeight}`
      : null;
  const serialPassed = dropLoop ? dropLoop.cycle.sn : facts.sawSn;
  drafts.push({
    id: 'serial',
    reached: serialPassed ? 'done' : pictureLabel ? 'skipped' : false,
    doneDetail: 'The dash checked the phone and it passed.',
    activeDetail: 'Waiting for the dash to check the phone.',
    activeHint: HINT_SERIAL,
  });

  drafts.push({
    id: 'picture',
    reached: pictureLabel ? 'done' : false,
    doneDetail:
      capture && !dropLoop
        ? `${pictureLabel} at ${capture.fps} fps${
            capture.width !== capture.deviceWidth || capture.height !== capture.deviceHeight
              ? ` (sent as ${capture.width}x${capture.height})`
              : ''
          }.`
        : `${pictureLabel}.`,
    activeDetail: 'Waiting for the dash to ask for a picture size.',
    activeHint: HINT_PICTURE,
  });

  const pulling = snapshot.state === 'streaming' || snapshot.framesSent > 0 || facts.dataOpened;
  drafts.push({
    id: 'pulls',
    reached: !dropLoop && rank >= RANK.negotiated && pulling ? 'done' : false,
    doneDetail: 'The dash opened the video channel.',
    activeDetail: 'The dash has not asked for video yet.',
    activeHint: HINT_PULLS,
  });

  const flowing = snapshot.state === 'streaming' && snapshot.framesSent > 0;
  const source = input.mirroring ? 'phone screen' : 'MotoLink dash pages';
  drafts.push({
    id: 'frames',
    reached: flowing ? 'done' : false,
    doneDetail: `${plural(snapshot.framesSent, 'frame')} sent${
      snapshot.framesDropped > 0 ? `, ${snapshot.framesDropped.toLocaleString('en-US')} dropped` : ''
    } (${source}).`,
    activeDetail: 'No picture has reached the dash yet.',
    activeHint: hintFrames(input.mirroring),
  });

  // Walk in order: everything before the first unreached step is done.
  const steps: ChecklistStep[] = [];
  let stuck: StepId | null = null;
  let headline = '';
  for (const draft of drafts) {
    const base = { id: draft.id, title: TITLES[draft.id] };
    if (stuck) {
      steps.push({ ...base, status: 'waiting', detail: 'Not reached yet.' });
      continue;
    }
    if (draft.reached === 'done') {
      steps.push({ ...base, status: 'done', detail: draft.doneDetail });
      continue;
    }
    if (draft.reached === 'skipped') {
      steps.push({ ...base, status: 'skipped', detail: 'The dash did not ask for one.' });
      continue;
    }
    stuck = draft.id;
    if (dropLoop && RANK[snapshot.state] < RANK.streaming && isAfterCallback(draft.id)) {
      const after = dropLoop.seconds !== null ? ` after about ${dropLoop.seconds} s` : '';
      steps.push({
        ...base,
        status: 'failed',
        detail: `Connected, then the dash dropped the link${after} (${plural(dropLoop.count, 'time')}).`,
        hint: HINT_DROP_LOOP,
      });
      headline = 'The dash keeps dropping the link after a few seconds.';
    } else if (draft.failure) {
      steps.push({ ...base, status: 'failed', detail: draft.failure.detail, hint: draft.failure.hint });
      headline = draft.failure.headline ?? HEADLINE_FAILED[draft.id];
    } else if (snapshot.lastError && draft.id !== 'paired') {
      const keyError = /^RSA key/i.test(snapshot.lastError);
      steps.push({
        ...base,
        status: 'failed',
        detail: `Last try failed: ${shortError(snapshot.lastError)}`,
        hint: keyError ? HINT_PHONE_KEY : draft.activeHint,
      });
      headline = keyError ? 'The phone could not prepare the link.' : HEADLINE_FAILED[draft.id];
    } else {
      steps.push({ ...base, status: 'active', detail: draft.activeDetail, hint: draft.activeHint });
      headline = HEADLINE_ACTIVE[draft.id];
    }
  }

  if (!stuck) {
    headline =
      snapshot.framesDropped > 0
        ? `The picture is on the dash, with ${plural(snapshot.framesDropped, 'frame')} dropped.`
        : 'The picture is on the dash.';
  }
  return { steps, stuck, headline };
}

function isAfterCallback(id: StepId): boolean {
  return id === 'identity' || id === 'serial' || id === 'picture' || id === 'pulls' || id === 'frames';
}

/** One short sentence for the top of the card. */
export function summary(checklist: Checklist): string {
  return checklist.headline;
}
