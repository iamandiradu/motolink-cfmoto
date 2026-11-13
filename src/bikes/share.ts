/**
 * Sharing bike details. A rider exports a small report so the bike can be
 * added to the registry; another rider imports a profile someone shared.
 *
 * The report must be safe to paste in a public issue: no Wi-Fi password, no
 * SSID suffix (it identifies the bike), no MAC, HUID or serial number.
 */
import { ACTIONS, DashAction } from '../buttons/mapping';
import { GESTURES, Gesture } from '../buttons/gestures';
import type { BikeCredentials } from '../protocol/qr';
import { LearnedBike } from './learned';
import { ProfileMatch, wifiKindOf } from './match';
import { BikeProfile, PanelSize, ProfileField, WifiKind, findProfile, isBuiltInProfileId } from './profiles';

export const REPORT_FORMAT = 'motolink-bike-report';
export const PROFILE_FORMAT = 'motolink-bike-profile';

export interface BikeReport {
  format: typeof REPORT_FORMAT;
  version: 1;
  detected: { profile: string; confidence: string } | null;
  chosenProfile: string | null;
  modelId: string | null;
  /** SSID with the bike-specific part masked, e.g. "CFMOTO-***". */
  ssidPrefix: string;
  wifi: WifiKind | null;
  sdkVersion: string | null;
  huName: string | null;
  panel: PanelSize | null;
  encoded: PanelSize | null;
  fps: number | null;
  touch: boolean | null;
  identities: { phoneOs: string; supportFunction: number; streamed: boolean }[];
  note: string | null;
}

/** Keeps the leading word of the SSID and masks the rest. */
export function redactSsid(ssid: string): string {
  const head = /^[A-Za-z]{1,10}[-_ ]?/.exec(ssid)?.[0] ?? '';
  return `${head}***`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Values from the QR that must never leave the phone. */
function secretsOf(creds: Partial<BikeCredentials> | null | undefined, ssid: string, extra: readonly string[]): string[] {
  const out = [ssid, ...extra];
  const suffix = ssid.slice(redactSsid(ssid).length - 3);
  if (suffix.length >= 3) out.push(suffix);
  if (creds) {
    if (creds.password) out.push(creds.password);
    if (creds.mac) out.push(creds.mac, creds.mac.replace(/:/g, ''));
    if (creds.name) out.push(creds.name);
    const sn = creds.raw ? /[?&]sn=([^&#]*)/i.exec(creds.raw)?.[1] : undefined;
    if (sn) out.push(sn);
  }
  // Longest first so a suffix does not leave half of the full value behind.
  return [...new Set(out.filter((s) => s.length >= 3))].sort((a, b) => b.length - a.length);
}

/**
 * Masks secrets in free text (HU name, rider note). Beyond the known values it
 * also masks anything shaped like a MAC address or a long hex / digit run,
 * since dash names often embed the serial.
 */
export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.replace(new RegExp(escapeRegExp(secret), 'gi'), '***');
  out = out.replace(/\b[0-9a-f]{2}([:-][0-9a-f]{2}){5}\b/gi, '***');
  out = out.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/gi, '***');
  out = out.replace(/\d{6,}/g, '***');
  return out;
}

export interface ExportInput {
  learned: LearnedBike;
  match?: ProfileMatch | null;
  /** Only used to know what to redact and the Wi-Fi kind; never copied. */
  credentials?: BikeCredentials | null;
  /** Dash HUID, if the caller has it, so it can be scrubbed from the HU name. */
  huid?: string | null;
  note?: string | null;
}

export function buildBikeReport(input: ExportInput): BikeReport {
  const { learned, match, credentials } = input;
  const secrets = secretsOf(credentials, learned.ssid, input.huid ? [input.huid] : []);
  const capture = learned.capture;
  const note = input.note?.trim() ? scrubText(input.note.trim(), secrets).slice(0, 500) : null;
  return {
    format: REPORT_FORMAT,
    version: 1,
    detected: match ? { profile: match.profile.id, confidence: match.confidence } : null,
    chosenProfile: learned.chosenProfileId,
    modelId: learned.modelId,
    ssidPrefix: redactSsid(learned.ssid),
    wifi: credentials ? wifiKindOf(credentials) : null,
    sdkVersion: learned.sdkVersion,
    // Swap the SSID for its masked form first so "CFMOTO-f46457" reads "CFMOTO-***", not "***".
    huName: learned.huName ? scrubText(learned.huName.split(learned.ssid).join(redactSsid(learned.ssid)), secrets) : null,
    panel: capture ? { width: capture.deviceWidth, height: capture.deviceHeight } : null,
    encoded: capture ? { width: capture.width, height: capture.height } : null,
    fps: capture?.fps ?? null,
    touch: learned.supportScreenTouch,
    identities: learned.identities.map((r) => ({ phoneOs: r.phoneOs, supportFunction: r.supportFunction, streamed: r.streamed })),
    note,
  };
}

/** JSON a rider can share. See buildBikeReport for what is left out. */
export function exportBikeReport(input: ExportInput): string {
  return JSON.stringify(buildBikeReport(input), null, 2);
}

// ---- import -----------------------------------------------------------------

export type ImportResult = { ok: true; profile: BikeProfile } | { ok: false; error: string };

const MAX_IMPORT_CHARS = 16_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_ID_RE = /^\d{1,12}$/;
const SDK_RE = /^\d{1,4}(\.\d{1,4}){0,3}$/;
const FIELDS: readonly ProfileField[] = ['modelIds', 'sdkPrefixes', 'panel', 'wifi', 'touch', 'supportFunction', 'layout'];

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message);
}

function text(v: unknown, field: string, max: number, required: boolean): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${field} is missing`);
    return null;
  }
  if (typeof v !== 'string') fail(`${field} must be text`);
  const s = v.trim();
  if (s.length === 0 && required) fail(`${field} is missing`);
  if (s.length > max) fail(`${field} is too long`);
  // Control characters have no business in a profile and would garble the UI.
  if (/[\u0000-\u001f\u007f]/.test(s)) fail(`${field} has odd characters`);
  return s;
}

function stringList(v: unknown, field: string, re: RegExp, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) fail(`${field} must be a short list`);
  return v.map((item) => {
    const s = typeof item === 'number' ? String(item) : item;
    if (typeof s !== 'string' || !re.test(s)) fail(`${field} has a bad entry`);
    return s;
  });
}

function panel(v: unknown, field: string): PanelSize | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object') fail(`${field} must be {width, height}`);
  const o = v as Record<string, unknown>;
  const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 64 && n <= 4096;
  if (!ok(o.width) || !ok(o.height)) fail(`${field} size is out of range`);
  return { width: o.width as number, height: o.height as number };
}

function wifi(v: unknown): WifiKind | null {
  if (v === undefined || v === null) return null;
  if (v !== 'ap' && v !== 'p2p') fail('wifi must be "ap" or "p2p"');
  return v;
}

function boolOrNull(v: unknown, field: string): boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') fail(`${field} must be true or false`);
  return v;
}

function supportFunction(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffff) fail('supportFunction is out of range');
  return v;
}

function layout(v: unknown): Partial<Record<Gesture, DashAction>> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) fail('layout must be an object');
  const out: Partial<Record<Gesture, DashAction>> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (!(GESTURES as readonly string[]).includes(key)) fail(`layout has an unknown button "${key.slice(0, 20)}"`);
    if (typeof value !== 'string' || !(ACTIONS as readonly string[]).includes(value)) fail(`layout has an unknown action for ${key}`);
    out[key as Gesture] = value as DashAction;
  }
  return out;
}

function guessedList(v: unknown): ProfileField[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('guessed must be a list');
  return v.map((f) => {
    if (!(FIELDS as readonly unknown[]).includes(f)) fail('guessed has an unknown field');
    return f as ProfileField;
  });
}

function checkId(id: string): string {
  if (!ID_RE.test(id)) fail('id must be lower-case letters, digits and dashes');
  if (isBuiltInProfileId(id)) fail(`id "${id}" is already a built-in profile`);
  return id;
}

function profileFromJson(o: Record<string, unknown>): BikeProfile {
  const id = checkId(text(o.id, 'id', 40, true)!);
  const layoutOverride = layout(o.layout);
  return {
    id,
    name: text(o.name, 'name', 60, true)!,
    dash: text(o.dash, 'dash', 60, false),
    modelIds: stringList(o.modelIds, 'modelIds', MODEL_ID_RE, 12),
    sdkPrefixes: stringList(o.sdkPrefixes, 'sdkPrefixes', SDK_RE, 8),
    panel: panel(o.panel, 'panel'),
    ...(typeof o.panelWidthHint === 'number' && Number.isInteger(o.panelWidthHint) && o.panelWidthHint >= 64 && o.panelWidthHint <= 4096
      ? { panelWidthHint: o.panelWidthHint }
      : {}),
    wifi: wifi(o.wifi),
    touch: boolOrNull(o.touch, 'touch'),
    supportFunction: supportFunction(o.supportFunction),
    ...(layoutOverride ? { layout: layoutOverride } : {}),
    verified: o.verified === true,
    guessed: guessedList(o.guessed),
    notes: text(o.notes, 'notes', 500, false) ?? '',
  };
}

/** Turns a shared report into a profile draft. Backed by a real dash, so verified. */
function profileFromReport(o: Record<string, unknown>): BikeProfile {
  const modelId = text(o.modelId, 'modelId', 12, false);
  if (modelId !== null && !MODEL_ID_RE.test(modelId)) fail('modelId must be digits');
  const sdk = text(o.sdkVersion, 'sdkVersion', 40, false);
  const sdkPrefix = sdk ? sdk.split('.').slice(0, 3).join('.') : null;
  if (sdkPrefix !== null && !SDK_RE.test(sdkPrefix)) fail('sdkVersion is not a version');
  const chosen = text(o.chosenProfile, 'chosenProfile', 40, false);
  const detected = o.detected && typeof o.detected === 'object' ? (o.detected as Record<string, unknown>).profile : null;
  const base = findProfile(chosen ?? (typeof detected === 'string' ? detected : null));
  const identities = Array.isArray(o.identities) ? o.identities : [];
  const working = identities.find(
    (r): r is { supportFunction: number } =>
      !!r && typeof r === 'object' && (r as Record<string, unknown>).streamed === true && typeof (r as Record<string, unknown>).supportFunction === 'number',
  );
  const name = base && base.id !== 'generic' ? `${base.name} (shared)` : modelId ? `Shared bike ${modelId}` : 'Shared bike';
  return {
    id: checkId(`custom-${modelId ?? 'bike'}`),
    name,
    dash: null,
    modelIds: modelId ? [modelId] : [],
    sdkPrefixes: sdkPrefix ? [sdkPrefix] : [],
    panel: panel(o.panel, 'panel'),
    wifi: wifi(o.wifi),
    touch: boolOrNull(o.touch, 'touch'),
    supportFunction: working ? supportFunction(working.supportFunction) : null,
    verified: true,
    guessed: [],
    notes: 'From a shared bike report.',
  };
}

/**
 * Validates a profile someone shared: either a profile JSON or a bike report.
 * Strict on purpose; a bad profile would quietly send the wrong settings.
 */
export function parseProfileJson(input: string): ImportResult {
  if (typeof input !== 'string' || input.length === 0) return { ok: false, error: 'Nothing to import.' };
  if (input.length > MAX_IMPORT_CHARS) return { ok: false, error: 'Too long to be a bike profile.' };
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'Not a bike profile.' };
  const o = json as Record<string, unknown>;
  try {
    if (o.format === REPORT_FORMAT) return { ok: true, profile: profileFromReport(o) };
    if (o.format !== undefined && o.format !== PROFILE_FORMAT) fail('Not a bike profile.');
    return { ok: true, profile: profileFromJson(o) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message.charAt(0).toUpperCase() + error.message.slice(1).replace(/\.?$/, '.') };
    throw error;
  }
}

/** A profile as shareable JSON, readable back by parseProfileJson. */
export function exportProfileJson(profile: BikeProfile): string {
  return JSON.stringify({ format: PROFILE_FORMAT, ...profile }, null, 2);
}
