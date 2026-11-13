/**
 * Roadside checklist: turns what the app knows about the link into an ordered
 * list of steps a rider can read with the bike running. Pure.
 *
 * The session snapshot is trusted first. Log lines are only read for what the
 * snapshot cannot tell: whether the probe was accepted or refused, whether the
 * dash called back at all, the serial check, the video channel opening and a
 * connect-then-drop loop.
 */
import { TranslationKey, t } from '../i18n';
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

// Texts are looked up when the checklist is built, so they follow the app
// language. The log lines it reads stay English: they are matched exactly.

const hint = (causes: string[], actions: string[]): StepHint => ({ causes, actions });

function hintPair(): StepHint {
  return hint([t('checklist.hint.pairCause')], [t('checklist.hint.pairAction1'), t('checklist.hint.pairAction2')]);
}

function hintNoWifi(joinUnavailable: boolean): StepHint {
  const causes = [t('checklist.hint.noWifiCause')];
  if (joinUnavailable) causes.push(t('checklist.hint.noWifiJoinCause'));
  return hint(causes, [
    t('checklist.hint.noWifiAction1'),
    t('checklist.hint.noWifiAction2'),
    t('checklist.hint.noWifiAction3'),
  ]);
}

function hintOtherWifi(): StepHint {
  return hint([t('checklist.hint.otherWifiCause')], [t('checklist.hint.otherWifiAction1'), t('checklist.hint.otherWifiAction2')]);
}

function hintProbeRefused(): StepHint {
  return hint(
    [t('checklist.hint.refusedCause1'), t('checklist.hint.refusedCause2')],
    [t('checklist.hint.refusedAction1'), t('checklist.hint.refusedAction2'), t('checklist.hint.refusedAction3')],
  );
}

function hintProbeSilent(): StepHint {
  return hint(
    [t('checklist.hint.silentCause1'), t('checklist.hint.silentCause2')],
    [t('checklist.hint.silentAction1'), t('checklist.hint.silentAction2'), t('checklist.hint.silentAction3')],
  );
}

function hintCallback(): StepHint {
  return hint(
    [t('checklist.hint.callbackCause1'), t('checklist.hint.callbackCause2')],
    [t('checklist.hint.callbackAction1'), t('checklist.hint.callbackAction2'), t('checklist.hint.callbackAction3')],
  );
}

/** Identity, serial and picture steps: wait, then try the other dash generation. */
function hintWait(causes: string[]): StepHint {
  return hint(causes, [t('checklist.hint.wait'), t('checklist.hint.tryGeneration')]);
}

function hintPulls(): StepHint {
  return hint([t('checklist.hint.pullsCause')], [t('checklist.hint.pullsAction')]);
}

function hintFrames(mirroring: boolean): StepHint {
  return mirroring
    ? hint(
        [t('checklist.hint.framesMirrorCause1'), t('checklist.hint.framesMirrorCause2')],
        [t('checklist.hint.framesMirrorAction1'), t('checklist.hint.framesMirrorAction2')],
      )
    : hint([t('checklist.hint.framesCause')], [t('checklist.hint.framesAction')]);
}

function hintDropLoop(): StepHint {
  return hint([t('checklist.hint.dropCause')], [t('checklist.hint.dropAction1'), t('checklist.hint.dropAction2')]);
}

function hintPhoneKey(): StepHint {
  return hint([t('checklist.hint.keyCause')], [t('checklist.hint.keyAction')]);
}

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

/** Plural text with the count shown as before ("1,240"), and `count` for picking the form. */
function counted(key: TranslationKey, n: number, params: Record<string, string | number> = {}): string {
  return t(key, { ...params, count: n, n: n.toLocaleString('en-US') });
}

/** The same sentence with or without the dash address, so each language words both itself. */
function withAddress(key: TranslationKey, keyAt: TranslationKey, address: string | null): string {
  return address ? t(keyAt, { address }) : t(key);
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
    doneDetail: t('checklist.detail.pairedDone'),
    activeDetail: t('checklist.detail.pairedActive'),
    activeHint: hintPair(),
  });

  const wifiOk = kind === 'hotspot' || kind === 'direct';
  drafts.push({
    id: 'wifi',
    reached: wifiOk || rank >= RANK.waitingForDash || dropLoop ? 'done' : false,
    doneDetail: wifiOk
      ? t(kind === 'hotspot' ? 'checklist.detail.wifiHotspot' : 'checklist.detail.wifiDirect', { ip: input.phoneIp ?? '' })
      : t('checklist.detail.wifiDash', { ip: input.phoneIp ?? t('checklist.detail.addressUnknown') }),
    activeDetail:
      kind === 'none'
        ? t('checklist.detail.wifiNoAddress')
        : t('checklist.detail.wifiOther', { ip: input.phoneIp ?? '' }),
    activeHint: kind === 'other' ? hintOtherWifi() : hintNoWifi(facts.joinUnavailable),
    failure:
      kind === 'other' && rank > 0
        ? {
            detail: t('checklist.detail.wifiOther', { ip: input.phoneIp ?? '' }),
            hint: hintOtherWifi(),
            headline: t('checklist.detail.wifiOtherHeadline'),
          }
        : undefined,
  });

  const dashAt = input.dashAddress;
  const probe = facts.lastProbe?.result ?? null;
  const probeDone = rank >= RANK.waitingForDash || (rank === RANK.probing && probe === 'accepted') || !!dropLoop;
  let probeFailure: StepDraft['failure'];
  if (probe === 'rejected' || probe === 'refused') {
    probeFailure = {
      detail:
        probe === 'rejected'
          ? withAddress('checklist.detail.probeRejected', 'checklist.detail.probeRejectedAt', dashAt)
          : withAddress('checklist.detail.probeRefused', 'checklist.detail.probeRefusedAt', dashAt),
      hint: hintProbeRefused(),
    };
  } else if (probe === 'timeout' || probe === 'error') {
    probeFailure = {
      detail: withAddress('checklist.detail.probeSilent', 'checklist.detail.probeSilentAt', dashAt),
      hint: hintProbeSilent(),
    };
  }
  drafts.push({
    id: 'probe',
    reached: probeDone ? 'done' : false,
    doneDetail: withAddress('checklist.detail.probeDone', 'checklist.detail.probeDoneAt', dashAt),
    activeDetail:
      rank === 0
        ? t('checklist.detail.probeIdle')
        : withAddress('checklist.detail.probeAsking', 'checklist.detail.probeAskingAt', dashAt),
    activeHint: hintProbeSilent(),
    failure: probeFailure,
  });

  drafts.push({
    id: 'callback',
    reached: rank >= RANK.handshaking || dropLoop ? 'done' : false,
    doneDetail: t('checklist.detail.callbackDone'),
    activeDetail: t('checklist.detail.callbackActive'),
    activeHint: hintCallback(),
    failure:
      facts.noCallback && rank < RANK.waitingForDash
        ? { detail: t('checklist.detail.callbackFailed'), hint: hintCallback() }
        : undefined,
  });

  const identityReached = dropLoop ? dropLoop.cycle.info : rank >= RANK.handshaking && !!dash;
  drafts.push({
    id: 'identity',
    reached: identityReached ? 'done' : false,
    doneDetail: version ? t('checklist.detail.identityDone', { version }) : t('checklist.detail.identityNoVersion'),
    activeDetail: t('checklist.detail.identityActive'),
    activeHint: hintWait([t('checklist.hint.identityCause')]),
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
    doneDetail: t('checklist.detail.serialDone'),
    activeDetail: t('checklist.detail.serialActive'),
    activeHint: hintWait([t('checklist.hint.serialCause')]),
  });

  drafts.push({
    id: 'picture',
    reached: pictureLabel ? 'done' : false,
    doneDetail:
      capture && !dropLoop
        ? capture.width !== capture.deviceWidth || capture.height !== capture.deviceHeight
          ? t('checklist.detail.pictureDoneSent', {
              size: pictureLabel ?? '',
              fps: capture.fps,
              sent: `${capture.width}x${capture.height}`,
            })
          : t('checklist.detail.pictureDone', { size: pictureLabel ?? '', fps: capture.fps })
        : t('checklist.detail.pictureSize', { size: String(pictureLabel) }),
    activeDetail: t('checklist.detail.pictureActive'),
    activeHint: hintWait([t('checklist.hint.pictureCause1'), t('checklist.hint.pictureCause2')]),
  });

  const pulling = snapshot.state === 'streaming' || snapshot.framesSent > 0 || facts.dataOpened;
  drafts.push({
    id: 'pulls',
    reached: !dropLoop && rank >= RANK.negotiated && pulling ? 'done' : false,
    doneDetail: t('checklist.detail.pullsDone'),
    activeDetail: t('checklist.detail.pullsActive'),
    activeHint: hintPulls(),
  });

  const flowing = snapshot.state === 'streaming' && snapshot.framesSent > 0;
  const source = input.mirroring ? t('checklist.detail.sourcePhone') : t('checklist.detail.sourcePages');
  drafts.push({
    id: 'frames',
    reached: flowing ? 'done' : false,
    doneDetail:
      snapshot.framesDropped > 0
        ? counted('checklist.detail.framesSentDropped', snapshot.framesSent, {
            dropped: snapshot.framesDropped.toLocaleString('en-US'),
            source,
          })
        : counted('checklist.detail.framesSent', snapshot.framesSent, { source }),
    activeDetail: t('checklist.detail.framesActive'),
    activeHint: hintFrames(input.mirroring),
  });

  // Walk in order: everything before the first unreached step is done.
  const steps: ChecklistStep[] = [];
  let stuck: StepId | null = null;
  let headline = '';
  for (const draft of drafts) {
    const base = { id: draft.id, title: t(`checklist.titles.${draft.id}`) };
    if (stuck) {
      steps.push({ ...base, status: 'waiting', detail: t('checklist.detail.waiting') });
      continue;
    }
    if (draft.reached === 'done') {
      steps.push({ ...base, status: 'done', detail: draft.doneDetail });
      continue;
    }
    if (draft.reached === 'skipped') {
      steps.push({ ...base, status: 'skipped', detail: t('checklist.detail.skipped') });
      continue;
    }
    stuck = draft.id;
    if (dropLoop && RANK[snapshot.state] < RANK.streaming && isAfterCallback(draft.id)) {
      steps.push({
        ...base,
        status: 'failed',
        detail:
          dropLoop.seconds !== null
            ? counted('checklist.detail.dropLoopAfter', dropLoop.count, { s: dropLoop.seconds })
            : counted('checklist.detail.dropLoop', dropLoop.count),
        hint: hintDropLoop(),
      });
      headline = t('checklist.detail.dropLoopHeadline');
    } else if (draft.failure) {
      steps.push({ ...base, status: 'failed', detail: draft.failure.detail, hint: draft.failure.hint });
      headline = draft.failure.headline ?? t(`checklist.failed.${draft.id}`);
    } else if (snapshot.lastError && draft.id !== 'paired') {
      const keyError = /^RSA key/i.test(snapshot.lastError);
      steps.push({
        ...base,
        status: 'failed',
        detail: t('checklist.detail.lastTry', { error: shortError(snapshot.lastError) }),
        hint: keyError ? hintPhoneKey() : draft.activeHint,
      });
      headline = keyError ? t('checklist.detail.keyHeadline') : t(`checklist.failed.${draft.id}`);
    } else {
      steps.push({ ...base, status: 'active', detail: draft.activeDetail, hint: draft.activeHint });
      headline = t(`checklist.active.${draft.id}`);
    }
  }

  if (!stuck) {
    headline =
      snapshot.framesDropped > 0
        ? counted('checklist.detail.allDoneDropped', snapshot.framesDropped)
        : t('checklist.detail.allDone');
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
