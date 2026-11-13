#!/usr/bin/env node
/**
 * MotoLink dash simulator: plays the CFMOTO dash's side of the Carbit EasyConn
 * ("PXC") link so the phone app can be exercised end to end without the bike.
 *
 * Written from the protocol notes (docs, comments in src/protocol and the
 * native LinkServer), deliberately NOT from the app's TypeScript: if the app's
 * encoder or parser is wrong, this file must not inherit the same mistake.
 * It checks the app against our understanding of the protocol, not against a
 * real dash.
 *
 * Topology: the dash listens on 10930 for one probe frame, answers it, then
 * dials back to the phone, which is the TCP server on 10922 (two control
 * connections), 10921 (media control) and 10920 (media data, pulled).
 *
 * Node >= 22, ESM, node: built-ins only. Run with --help for options.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------- protocol ids

const CMD = {
  PROBE: 0x70000010,
  PROBE_REPLY: 0x70000011,
  HEARTBEAT: 0x70000000,
  HEARTBEAT_ACK: 0x70000001,
  SELECT_CAR_CTRL: 0x10000,
  SELECT_CAR_DATA: 0x20000,
  CLIENT_INFO: 0x10010,
  MEDIA_FEATURE_CFG: 0x10020,
  NOTIFY_10040: 0x10040,
  OTA_FTP_INFO: 0x103a0,
  CHECK_SN: 0x103e0,
  HU_QUERY_TIME: 0x10450,
  NOTIFY_10460: 0x10460,
  HU_TIME_SYNC: 0x10600,
  QUERY_SPEED: 0x10690,
  LOG_REPORT: 0x10780,
  CHECK_SN_RESULT: 0x201c0,
};

const MEDIA = {
  CONFIG_CAPTURE: 16,
  CONFIG_CAPTURE_REPLY: 17,
  GET_VERSION: 48,
  GET_VERSION_REPLY: 49,
  HEARTBEAT: 64,
  HEARTBEAT_REPLY: 65,
  CONFIG_EXTEND: 96,
  CONFIG_EXTEND_REPLY: 97,
  DATA_START: 112,
  DATA_START_REPLY: 113,
  DATA_NEXT: 114,
};

const CONTROL_HEADER = 16;
const MEDIA_HEADER = 8;
/** Anything larger is a desynchronised stream, not a real frame. */
const MAX_CONTROL_FRAME = 4 * 1024 * 1024;
const MAX_ACCESS_UNIT = 8 * 1024 * 1024;

function cmdName(cmd) {
  for (const [name, value] of Object.entries(CMD)) {
    if (value === cmd) return `${name} ${hex(cmd)}`;
    if (value + 1 === cmd) return `${name}_ACK ${hex(cmd)}`;
  }
  return hex(cmd);
}

function mediaName(type) {
  for (const [name, value] of Object.entries(MEDIA)) if (value === type) return `${name}(${type})`;
  return `media(${type})`;
}

function hex(n) {
  return `0x${(n >>> 0).toString(16)}`;
}

// ---------------------------------------------------------------- options

const USAGE = `Usage: node tools/dash-sim/dash-sim.mjs [options]

Plays the CFMOTO dash: listens for the phone's probe, dials back, runs the
handshake, negotiates video and pulls frames, checking everything on the way.

Network
  --bind <addr>               address to listen on for the probe (default 0.0.0.0)
  --probe-port <n>            dash probe port (default 10930)
  --phone <host>              dial back to this host instead of the probe's source
  --control-port <n>          phone control port (default 10922)
  --media-control-port <n>    phone media control port (default 10921)
  --media-data-port <n>       phone media data port (default 10920)

Dash behaviour
  --profile cfdl16|cfdl26     cfdl26 adds the notify burst and time sync (default cfdl16)
  --panel <W>x<H>             panel size asked for in CONFIG_CAPTURE (default 800x386)
  --fps <n>                   fps asked for (default 30)
  --pull-fps <n>              frame pull rate on 10920 (default 24)
  --huid <s> --serial <s> --sdk-version <s>   identity strings sent by the dash
  --strict-heartbeat          drop the link if the phone sends no heartbeat for 7 s
  --dash-heartbeat            also send dash heartbeats every 2 s and expect acks
  --frame-timeout <s>         no-frame timeout (default: socketTimeoutPeriodWifi = 9)

Run control
  --duration <s>              seconds to stream before finishing (default 10)
  --drop-after <s>            ignition cycle: stream this long, close everything,
                              go dark for --off-time, then wait for a new probe
  --off-time <s>              seconds the "ignition" stays off (default 3)
  --cycles <n>                link cycles to run (default 2 with --drop-after, else 1)
  --probe-timeout <s>         wait this long for the first probe (default 120)
  --reconnect-timeout <s>     wait this long for the probe after an ignition cycle (default 30)
  --reply-timeout <s>         wait this long for each handshake reply (default 5)

Output
  --out <file.h264>           write the received Annex-B stream (ffplay/VLC can play it)
  --snapshot <file.png>       extract one frame as PNG (needs ffmpeg on PATH)
  --json                      JSON result on stdout; the human log moves to stderr
  --verbose                   hex-dump every control and media frame
  --help
`;

let opt;
try {
  ({ values: opt } = parseArgs({
    options: {
      bind: { type: 'string', default: '0.0.0.0' },
      'probe-port': { type: 'string', default: '10930' },
      phone: { type: 'string' },
      'control-port': { type: 'string', default: '10922' },
      'media-control-port': { type: 'string', default: '10921' },
      'media-data-port': { type: 'string', default: '10920' },
      profile: { type: 'string', default: 'cfdl16' },
      panel: { type: 'string', default: '800x386' },
      fps: { type: 'string', default: '30' },
      'pull-fps': { type: 'string', default: '24' },
      huid: { type: 'string', default: 'CFDL0A1B2C3D4E5F6071' },
      serial: { type: 'string', default: 'LCETDK0A5S1000417' },
      'sdk-version': { type: 'string', default: '0.9.29.1' },
      'strict-heartbeat': { type: 'boolean', default: false },
      'dash-heartbeat': { type: 'boolean', default: false },
      'frame-timeout': { type: 'string' },
      duration: { type: 'string', default: '10' },
      'drop-after': { type: 'string' },
      'off-time': { type: 'string', default: '3' },
      cycles: { type: 'string' },
      'probe-timeout': { type: 'string', default: '120' },
      'reconnect-timeout': { type: 'string', default: '30' },
      'reply-timeout': { type: 'string', default: '5' },
      out: { type: 'string' },
      snapshot: { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  process.stderr.write(`${error.message}\n\n${USAGE}`);
  process.exit(2);
}

if (opt.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

function num(name, { min = 0, integer = false } = {}) {
  const raw = opt[name];
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    process.stderr.write(`--${name}: bad value "${raw}"\n`);
    process.exit(2);
  }
  return value;
}

const panelMatch = /^(\d{2,4})x(\d{2,4})$/.exec(opt.panel);
if (!panelMatch) {
  process.stderr.write(`--panel: expected WxH, got "${opt.panel}"\n`);
  process.exit(2);
}
if (opt.profile !== 'cfdl16' && opt.profile !== 'cfdl26') {
  process.stderr.write(`--profile: cfdl16 or cfdl26, got "${opt.profile}"\n`);
  process.exit(2);
}

const cfg = {
  bind: opt.bind,
  probePort: num('probe-port', { min: 1, integer: true }),
  controlPort: num('control-port', { min: 1, integer: true }),
  mediaControlPort: num('media-control-port', { min: 1, integer: true }),
  mediaDataPort: num('media-data-port', { min: 1, integer: true }),
  profile: opt.profile,
  panelW: Number(panelMatch[1]),
  panelH: Number(panelMatch[2]),
  fps: num('fps', { min: 1, integer: true }),
  pullFps: num('pull-fps', { min: 1 }),
  duration: num('duration', { min: 0.5 }),
  dropAfter: opt['drop-after'] !== undefined ? num('drop-after', { min: 0.5 }) : null,
  offTime: num('off-time'),
  probeTimeout: num('probe-timeout', { min: 1 }),
  reconnectTimeout: num('reconnect-timeout', { min: 1 }),
  replyTimeout: num('reply-timeout', { min: 0.5 }),
  frameTimeout: opt['frame-timeout'] !== undefined ? num('frame-timeout', { min: 0.5 }) : null,
};
cfg.cycles = opt.cycles !== undefined ? num('cycles', { min: 1, integer: true }) : cfg.dropAfter ? 2 : 1;

// ---------------------------------------------------------------- logging and checks

/** With --json, stdout carries only the JSON result so it can be piped. */
const out = opt.json ? process.stderr : process.stdout;
const startedAt = Date.now();

function stamp() {
  const d = new Date();
  const rel = ((Date.now() - startedAt) / 1000).toFixed(3).padStart(7);
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')} +${rel}s`;
}

function log(tag, message) {
  out.write(`${stamp()} ${tag.padEnd(6)} ${message}\n`);
}

function hexdump(buf, limit = 256) {
  if (!opt.verbose) return;
  const shown = buf.subarray(0, limit);
  for (let i = 0; i < shown.length; i += 16) {
    const row = shown.subarray(i, i + 16);
    const hexPart = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    out.write(`${' '.repeat(29)}${i.toString(16).padStart(4, '0')}  ${hexPart.padEnd(48)} ${ascii}\n`);
  }
  if (buf.length > limit) out.write(`${' '.repeat(29)}... ${buf.length - limit} more bytes\n`);
}

const checks = [];
let currentCycle = 0;
/** Frames written to --out across all cycles, for the post-run ffmpeg steps. */
let framesWritten = 0;

function record(status, name, detail = '') {
  checks.push({ cycle: currentCycle, status, name, detail });
  log(status, detail ? `${name}: ${detail}` : name);
}
const pass = (name, detail) => record('PASS', name, detail);
const fail = (name, detail) => record('FAIL', name, detail);
const warn = (name, detail) => record('WARN', name, detail);
const info = (name, detail) => record('INFO', name, detail);

function check(ok, name, goodDetail, badDetail) {
  if (ok) pass(name, goodDetail);
  else fail(name, badDetail ?? goodDetail);
  return ok;
}

/** Aborts the current link cycle. The FAIL line is recorded before it is thrown. */
class Fatal extends Error {}

function fatal(name, detail) {
  fail(name, detail);
  throw new Fatal(`${name}: ${detail}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- framing

function encodeControl(cmd, payload) {
  const body =
    payload === undefined || payload === null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const total = CONTROL_HEADER + body.length;
  const head = Buffer.alloc(CONTROL_HEADER);
  head.writeUInt32LE(cmd >>> 0, 0);
  head.writeInt32LE(total, 4);
  head.writeInt32LE((cmd ^ total) | 0, 8);
  head.writeInt32LE(0, 12);
  return Buffer.concat([head, body]);
}

function encodeMedia(type, body = Buffer.alloc(0), token = 0) {
  const head = Buffer.alloc(MEDIA_HEADER);
  head.writeInt16LE(type, 0);
  head.writeUInt16LE(body.length, 2);
  head.writeInt32LE(token, 4);
  return Buffer.concat([head, body]);
}

class WireError extends Error {}

/** Control stream reader. Throws WireError on a header the dash would reject. */
class ControlReader {
  buf = Buffer.alloc(0);

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (this.buf.length >= CONTROL_HEADER) {
      const cmd = this.buf.readUInt32LE(0);
      const total = this.buf.readInt32LE(4);
      const magic = this.buf.readInt32LE(8);
      const reserved = this.buf.readInt32LE(12);
      const expected = (cmd ^ total) | 0;
      if (magic !== expected) {
        throw new WireError(
          `bad XOR magic for cmd ${hex(cmd)} (len ${total}): got ${hex(magic)}, expected cmd^len = ${hex(expected)}`,
        );
      }
      if (total < CONTROL_HEADER || total > MAX_CONTROL_FRAME) {
        throw new WireError(`bad total length ${total} for cmd ${hex(cmd)}`);
      }
      if (this.buf.length < total) break;
      frames.push({ cmd, reserved, payload: this.buf.subarray(CONTROL_HEADER, total), raw: this.buf.subarray(0, total) });
      this.buf = this.buf.subarray(total);
    }
    return frames;
  }
}

class MediaReader {
  buf = Buffer.alloc(0);

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (this.buf.length >= MEDIA_HEADER) {
      const len = this.buf.readUInt16LE(2);
      if (this.buf.length < MEDIA_HEADER + len) break;
      frames.push({
        type: this.buf.readInt16LE(0),
        token: this.buf.readInt32LE(4),
        body: this.buf.subarray(MEDIA_HEADER, MEDIA_HEADER + len),
        raw: this.buf.subarray(0, MEDIA_HEADER + len),
      });
      this.buf = this.buf.subarray(MEDIA_HEADER + len);
    }
    return frames;
  }
}

function parseJson(buf) {
  try {
    const value = JSON.parse(buf.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- H.264 inspection

/** Removes emulation-prevention bytes (00 00 03 -> 00 00). */
function unescapeRbsp(nal) {
  const outBytes = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    outBytes.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(outBytes);
}

class BitReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  u(n) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3];
      if (byte === undefined) throw new Error('truncated');
      value = value * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return value;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) throw new Error('bad Exp-Golomb code');
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.u(zeros);
  }
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Parses an SPS NAL (header byte included) far enough to get the picture size. */
function parseSps(nal) {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const sps = { profile: r.u(8), constraints: r.u(8), level: r.u(8), id: r.ue(), chroma: 1 };
  if (HIGH_PROFILES.has(sps.profile)) {
    sps.chroma = r.ue();
    if (sps.chroma === 3) r.u(1);
    r.ue();
    r.ue();
    r.u(1);
    if (r.u(1)) {
      for (let i = 0; i < (sps.chroma !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size && next !== 0; j++) {
          next = (last + r.se() + 256) % 256;
          if (next !== 0) last = next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  sps.maxRefFrames = r.ue();
  r.u(1);
  sps.mbWidth = r.ue() + 1;
  sps.mapHeight = r.ue() + 1;
  sps.frameMbsOnly = r.u(1);
  if (!sps.frameMbsOnly) r.u(1);
  r.u(1);
  const crop = { left: 0, right: 0, top: 0, bottom: 0 };
  if (r.u(1)) {
    crop.left = r.ue();
    crop.right = r.ue();
    crop.top = r.ue();
    crop.bottom = r.ue();
  }
  const cropX = sps.chroma === 1 || sps.chroma === 2 ? 2 : 1;
  const cropY = (sps.chroma === 1 ? 2 : 1) * (2 - sps.frameMbsOnly);
  sps.codedWidth = sps.mbWidth * 16;
  sps.codedHeight = (2 - sps.frameMbsOnly) * sps.mapHeight * 16;
  sps.width = sps.codedWidth - cropX * (crop.left + crop.right);
  sps.height = sps.codedHeight - cropY * (crop.top + crop.bottom);
  sps.crop = crop;
  return sps;
}

/** slice_type of a slice NAL, mod 5: 0 P, 1 B, 2 I. */
function sliceType(nal) {
  const r = new BitReader(unescapeRbsp(nal.subarray(1, 24)));
  r.ue();
  return r.ue() % 5;
}

/**
 * Splits one Annex-B access unit into NAL units. The pull reply must be a
 * complete unit starting with a start code; anything else would make the
 * dash's decoder resynchronise on garbage.
 */
function splitAnnexB(au) {
  if (au.length < 4) return { error: `only ${au.length} bytes` };
  const head3 = au[0] === 0 && au[1] === 0 && au[2] === 1;
  const head4 = au[0] === 0 && au[1] === 0 && au[2] === 0 && au[3] === 1;
  if (!head3 && !head4) {
    const lead = [...au.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return { error: `does not start with an Annex-B start code (first bytes ${lead}; AVCC length prefix?)` };
  }
  const starts = [];
  for (let i = 0; i + 2 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  const nals = [];
  for (let k = 0; k < starts.length; k++) {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : au.length;
    while (end > starts[k] && au[end - 1] === 0) end--;
    const nal = au.subarray(starts[k], end);
    if (nal.length === 0) return { error: `empty NAL unit #${k}` };
    if (nal[0] & 0x80) return { error: `NAL unit #${k} has forbidden_zero_bit set` };
    nals.push({ type: nal[0] & 0x1f, data: nal });
  }
  if (!nals.some((n) => n.type === 1 || n.type === 5)) {
    return { error: `no picture (NAL types [${nals.map((n) => n.type).join(',')}])` };
  }
  return { nals };
}

class StreamValidator {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.count = 0;
    this.idr = 0;
    this.p = 0;
    this.iNonIdr = 0;
    this.b = 0;
    this.bytes = 0;
    this.bad = [];
    this.idrWithoutParams = [];
    this.idrIndexes = [];
    this.firstAt = 0;
    this.lastAt = 0;
    this.maxGapMs = 0;
    this.sps = null;
    this.spsChanged = false;
  }

  add(au) {
    const index = this.count++;
    const now = Date.now();
    if (index === 0) this.firstAt = now;
    else this.maxGapMs = Math.max(this.maxGapMs, now - this.lastAt);
    this.lastAt = now;
    this.bytes += au.length;

    const split = splitAnnexB(au);
    if (split.error) {
      this.bad.push(`#${index}: ${split.error}`);
      if (index === 0) {
        fail('first frame after DATA_START is SPS+PPS+IDR', `frame is not a valid Annex-B unit: ${split.error}`);
      }
      return;
    }
    const types = split.nals.map((n) => n.type);
    const hasSps = types.includes(7);
    const hasPps = types.includes(8);
    const hasIdr = types.includes(5);

    if (index === 0) {
      const kind = hasIdr ? 'an IDR' : 'a P-frame';
      const missing = [!hasSps && 'SPS', !hasPps && 'PPS'].filter(Boolean).join('/');
      check(
        hasSps && hasPps && hasIdr,
        'first frame after DATA_START is SPS+PPS+IDR',
        `NAL types [${types.join(',')}]`,
        `NAL types [${types.join(',')}]: ${kind}${missing ? ` without ${missing}` : ''}; the dash decoder cannot start from it`,
      );
    }

    for (const nal of split.nals.filter((n) => n.type === 7)) this.inspectSps(nal.data);

    if (hasIdr) {
      this.idr++;
      this.idrIndexes.push(index);
      if (!hasSps || !hasPps) this.idrWithoutParams.push(index);
    } else {
      const slice = split.nals.find((n) => n.type === 1);
      try {
        const type = sliceType(slice.data);
        if (type === 0) this.p++;
        else if (type === 1) this.b++;
        else this.iNonIdr++;
      } catch {
        this.bad.push(`#${index}: unreadable slice header`);
      }
    }
  }

  inspectSps(nal) {
    let sps;
    try {
      sps = parseSps(nal);
    } catch (error) {
      if (!this.sps) fail('SPS parses', String(error.message ?? error));
      return;
    }
    if (this.sps) {
      if (sps.width !== this.sps.width || sps.height !== this.sps.height || sps.profile !== this.sps.profile) {
        if (!this.spsChanged) warn('SPS stable', `SPS changed mid-stream to profile ${sps.profile} ${sps.width}x${sps.height}`);
        this.spsChanged = true;
      }
      return;
    }
    this.sps = sps;
    pass('SPS parses', `seq_parameter_set_id ${sps.id}, max_num_ref_frames ${sps.maxRefFrames}`);
    const constrained = (sps.constraints & 0x40) !== 0;
    check(
      sps.profile === 66,
      'SPS profile is Baseline (66)',
      `profile_idc 66${constrained ? ', constraint_set1 (Constrained Baseline)' : ''}`,
      `profile_idc ${sps.profile}; the dash decoder is only known to take Baseline`,
    );
    const level = `level_idc ${sps.level} (${Math.floor(sps.level / 10)}.${sps.level % 10})`;
    if (sps.level > 31) warn('SPS level', `${level}: above 3.1, which is all the reference notes promise`);
    else info('SPS level', level);
    const coded = `coded ${sps.codedWidth}x${sps.codedHeight}, crop l${sps.crop.left} r${sps.crop.right} t${sps.crop.top} b${sps.crop.bottom}`;
    check(
      sps.width === this.width && sps.height === this.height,
      'SPS picture size matches negotiated size',
      `${sps.width}x${sps.height} (${coded})`,
      `SPS says ${sps.width}x${sps.height} (${coded}), negotiated ${this.width}x${this.height}`,
    );
  }

  summarise() {
    if (this.count === 0) {
      fail('video frames received', 'none');
      return;
    }
    const secs = Math.max(0.001, (this.lastAt - this.firstAt) / 1000);
    const fps = this.count > 1 ? ((this.count - 1) / secs).toFixed(1) : '-';
    const kbps = ((this.bytes * 8) / secs / 1000).toFixed(0);
    pass(
      'video frames received',
      `${this.count} frames in ${secs.toFixed(1)} s (${fps} fps, ${kbps} kbit/s); ${this.idr} keyframes, ${this.p} P-frames` +
        (this.iNonIdr ? `, ${this.iNonIdr} non-IDR I-frames` : ''),
    );
    check(
      this.bad.length === 0,
      'every frame is a valid Annex-B access unit',
      `${this.count} checked`,
      `${this.bad.length} bad: ${this.bad.slice(0, 5).join('; ')}${this.bad.length > 5 ? '; ...' : ''}`,
    );
    if (this.b > 0) fail('no B-frames (Baseline)', `${this.b} B-slices seen`);
    if (this.idrWithoutParams.length) {
      warn(
        'later keyframes carry SPS+PPS',
        `IDR without SPS/PPS at frames ${this.idrWithoutParams.slice(0, 5).join(', ')}; a dash that joined late could not decode`,
      );
    }
    if (this.idrIndexes.length > 1) {
      const gaps = this.idrIndexes.slice(1).map((v, i) => v - this.idrIndexes[i]);
      info('keyframe interval', `every ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)} frames`);
    } else {
      info('keyframe interval', `only ${this.idrIndexes.length} keyframe(s) in this run`);
    }
    info('largest gap between frames', `${this.maxGapMs} ms`);
  }
}

// ---------------------------------------------------------------- link plumbing

/** One dash-to-phone link (one ignition cycle). Owns sockets and timers. */
class Link {
  constructor(phoneHost) {
    this.phoneHost = phoneHost;
    this.closed = false;
    this.sockets = new Set();
    this.timers = new Set();
    this.dropped = new Promise((_, reject) => (this.rejectDrop = reject));
    this.dropped.catch(() => {});
  }

  /** Asynchronous failure (timer, socket event): records it and aborts the cycle. */
  drop(name, detail) {
    if (this.closed || this.dropReason) return;
    this.dropReason = `${name}: ${detail}`;
    fail(name, detail);
    this.rejectDrop(new Fatal(this.dropReason));
  }

  guard(promise) {
    return Promise.race([promise, this.dropped]);
  }

  every(ms, fn) {
    const t = setInterval(() => !this.closed && fn(), ms);
    this.timers.add(t);
    return t;
  }

  after(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  dial(port, name) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.phoneHost, port });
      socket.setNoDelay(true);
      this.sockets.add(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connect timeout'));
      }, cfg.replyTimeout * 1000);
      socket.once('connect', () => {
        clearTimeout(timer);
        log('net', `${name} connected to ${this.phoneHost}:${port}`);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }).catch((error) => fatal(`dial ${name}`, `${this.phoneHost}:${port}: ${error.code ?? error.message}`));
  }

  close() {
    this.closed = true;
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    for (const s of this.sockets) s.destroy();
  }
}

/** Base for the two framed sockets: routes replies to waiters, keeps the rest. */
class FramedConn {
  constructor(link, name, socket) {
    this.link = link;
    this.name = name;
    this.socket = socket;
    this.backlog = [];
    this.waiters = [];
    this.intercepts = [];
    this.seq = 0;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const w of this.waiters) w.resolve(null);
      this.waiters = [];
      this.link.drop(`${name} connection`, 'phone closed the connection');
    });
  }

  deliver(frame, key) {
    frame.seq = ++this.seq;
    for (const intercept of this.intercepts) if (intercept(frame)) return;
    const i = this.waiters.findIndex((w) => w.key === key);
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(frame);
    } else {
      this.backlog.push({ key, frame });
    }
  }

  /** Resolves the next frame with this key, or null after timeoutMs. */
  wait(key, timeoutMs = cfg.replyTimeout * 1000) {
    const i = this.backlog.findIndex((b) => b.key === key);
    if (i >= 0) return Promise.resolve(this.backlog.splice(i, 1)[0].frame);
    return new Promise((resolve) => {
      const waiter = { key, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

class ControlConn extends FramedConn {
  constructor(link, name, socket) {
    super(link, name, socket);
    this.reader = new ControlReader();
    this.openedAt = Date.now();
    this.lastPhoneBeat = Date.now();
    this.phoneBeats = 0;
    this.maxBeatGapMs = 0;
    this.dashBeatsSent = 0;
    this.dashBeatAcks = 0;
  }

  onData(chunk) {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      this.link.drop(`${this.name} framing`, `phone sent ${error.message}`);
      return;
    }
    for (const frame of frames) {
      if (frame.cmd === CMD.HEARTBEAT) {
        const now = Date.now();
        this.maxBeatGapMs = Math.max(this.maxBeatGapMs, now - this.lastPhoneBeat);
        this.lastPhoneBeat = now;
        this.phoneBeats++;
        // The dash answers the phone's heartbeat like any other request: cmd+1, empty.
        this.socket.write(encodeControl(CMD.HEARTBEAT_ACK));
        if (opt.verbose) log(this.name, `<- HEARTBEAT, -> HEARTBEAT_ACK`);
        continue;
      }
      if (frame.cmd === CMD.HEARTBEAT_ACK) {
        this.dashBeatAcks++;
        continue;
      }
      log(this.name, `<- ${cmdName(frame.cmd)} (${frame.payload.length} B)${frame.reserved ? ` reserved=${hex(frame.reserved)}` : ''}`);
      hexdump(frame.raw);
      this.deliver(frame, frame.cmd);
    }
  }

  send(cmd, payload) {
    const data = encodeControl(cmd, payload);
    if (cmd !== CMD.HEARTBEAT || opt.verbose) log(this.name, `-> ${cmdName(cmd)} (${data.length - CONTROL_HEADER} B)`);
    hexdump(data);
    this.socket.write(data);
  }

  /** Waits for a reply and aborts the cycle when it does not come. */
  async expect(cmd, checkName) {
    const frame = await this.wait(cmd);
    if (!frame) {
      if (this.link.closed || this.link.dropReason) throw new Fatal('link closed');
      fatal(checkName, `no ${cmdName(cmd)} from the phone within ${cfg.replyTimeout} s`);
    }
    return frame;
  }
}

class MediaConn extends FramedConn {
  constructor(link, name, socket) {
    super(link, name, socket);
    this.reader = new MediaReader();
  }

  onData(chunk) {
    for (const frame of this.reader.push(chunk)) {
      if (frame.type !== MEDIA.HEARTBEAT_REPLY || opt.verbose) {
        log(this.name, `<- ${mediaName(frame.type)} (${frame.body.length} B, token ${frame.token})`);
      }
      hexdump(frame.raw);
      this.deliver(frame, frame.type);
    }
  }

  send(type, body) {
    const data = encodeMedia(type, body);
    if (type !== MEDIA.HEARTBEAT || opt.verbose) log(this.name, `-> ${mediaName(type)} (${data.length - MEDIA_HEADER} B)`);
    hexdump(data);
    this.socket.write(data);
  }

  async expect(type, checkName) {
    const frame = await this.wait(type);
    if (!frame) {
      if (this.link.closed || this.link.dropReason) throw new Fatal('link closed');
      fatal(checkName, `no ${mediaName(type)} from the phone within ${cfg.replyTimeout} s`);
    }
    return frame;
  }
}

// ---------------------------------------------------------------- probe listener

class ProbeServer {
  constructor() {
    this.server = null;
    this.waiter = null;
    this.ready = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handle(socket));
      this.server.once('error', reject);
      this.server.listen(cfg.probePort, cfg.bind, () => {
        log('probe', `listening on ${cfg.bind}:${cfg.probePort}`);
        resolve();
      });
    });
  }

  /** Simulates the dash being switched off: the port stops answering. */
  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  /** Next probe outcome: { ok, host } or null on timeout. */
  next(timeoutSec) {
    if (this.ready.length) return Promise.resolve(this.ready.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutSec * 1000);
      this.waiter = (result) => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(result);
      };
    });
  }

  handle(socket) {
    const source = (socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const reader = new ControlReader();
    const waiting = !!this.waiter;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (this.waiter) this.waiter(result);
      else if (waiting) this.ready.push(result);
    };
    log('probe', `connection from ${source}:${socket.remotePort}${waiting ? '' : ' (while linked)'}`);
    const timer = setTimeout(() => {
      if (waiting) fail('probe frame', `connection from ${source} sent no complete frame within 5 s`);
      socket.destroy();
      finish({ ok: false });
    }, 5000);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (done) return;
      let frames;
      try {
        frames = reader.push(chunk);
      } catch (error) {
        hexdump(chunk);
        if (waiting) fail('probe header', `${error.message}; a real dash ignores such a probe and never answers`);
        else warn('probe header (while linked)', error.message);
        socket.destroy();
        finish({ ok: false });
        return;
      }
      if (!frames.length) return;
      const frame = frames[0];
      hexdump(frame.raw);
      if (!waiting) {
        // A phone that re-probes while linked is harmless; answer it like the dash would.
        log('probe', `extra probe while linked (${cmdName(frame.cmd)}), answered`);
        socket.end(encodeControl(CMD.PROBE_REPLY, { status: true }));
        done = true;
        clearTimeout(timer);
        return;
      }
      if (frame.cmd !== CMD.PROBE) {
        fail('probe command', `expected ${hex(CMD.PROBE)}, got ${cmdName(frame.cmd)}`);
        socket.destroy();
        return finish({ ok: false });
      }
      pass('probe header', `cmd ${hex(frame.cmd)}, len ${frame.raw.length}, XOR magic correct`);
      if (frame.reserved !== 0) warn('probe header reserved word', `${hex(frame.reserved)}, expected 0`);
      const json = parseJson(frame.payload);
      const okJson =
        json && typeof json.phoneType === 'string' && json.phoneType && typeof json.packageName === 'string' && json.packageName;
      if (!check(
        !!okJson,
        'probe JSON has phoneType and packageName',
        json && `phoneType=${json.phoneType} packageName=${json.packageName}`,
        `payload ${JSON.stringify(frame.payload.toString('utf8').slice(0, 120))}`,
      )) {
        socket.destroy();
        return finish({ ok: false });
      }
      log('probe', `-> PROBE_REPLY {"status":true}`);
      socket.end(encodeControl(CMD.PROBE_REPLY, { status: true }));
      finish({ ok: true, host: opt.phone ?? source, json });
    });
  }
}

// ---------------------------------------------------------------- dash messages

function dashClientInfo() {
  // HUID, sdkVersion, socketTimeoutPeriodWifi and supportScreenTouch are what the
  // phone acts on; the rest mirrors the shape the notes describe, filled plausibly.
  return {
    HUID: opt.huid,
    HUName: cfg.profile === 'cfdl26' ? 'CFMOTO-CFDL26' : 'CFMOTO-CFDL16',
    sdkVersion: opt['sdk-version'],
    channel: 'cfmoto',
    flavor: 65540,
    socketTimeoutPeriodWifi: 9,
    supportScreenTouch: false,
    pxcVersion: '1.0.2',
    huVersion: cfg.profile === 'cfdl26' ? 'CFDL26_V2.0.3' : 'CFDL16_V1.2.7',
    width: cfg.panelW,
    height: cfg.panelH,
    dpi: 160,
    supportAudio: false,
    supportBluetoothPhone: true,
    mac: '02:00:00:00:00:00',
  };
}

/** yyyy-MM-dd HH:mm:ss.SSS000000, local time, 29 ASCII characters. */
function dashStamp(date) {
  const p = (n, w) => String(n).padStart(w, '0');
  return (
    `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1, 2)}-${p(date.getDate(), 2)} ` +
    `${p(date.getHours(), 2)}:${p(date.getMinutes(), 2)}:${p(date.getSeconds(), 2)}.${p(date.getMilliseconds(), 3)}000000`
  );
}

const UNSET_CLOCK = '1970-01-01 00:00:00.000000000';
const TIME_SYNC_CHANNEL = 1;

function timeSyncBody(seq, stampText) {
  const body = Buffer.alloc(45);
  body.writeInt32LE(-2, 0);
  body.writeInt32LE(TIME_SYNC_CHANNEL, 4);
  body.writeInt32LE(seq, 8);
  body.writeInt32LE(0, 12);
  body.write(stampText, 16, 29, 'ascii');
  return body;
}

function parseStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\d{6}$/.exec(text);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

/**
 * CONFIG_CAPTURE body. Documented: int16 width @0, int16 height @2, int32 fps
 * @4, int32 wantEncoder @8 (2 = H.264), byte @29 extend flag (echoed in the
 * reply). The other bytes are not in our notes; they are zero except a dpi
 * guess, so the phone must not depend on them.
 */
function captureBody() {
  const body = Buffer.alloc(32);
  body.writeInt16LE(cfg.panelW, 0);
  body.writeInt16LE(cfg.panelH, 2);
  body.writeInt32LE(cfg.fps, 4);
  body.writeInt32LE(2, 8);
  body.writeInt32LE(160, 16);
  // A non-zero flag, so a phone that never reads it cannot pass by echoing zero.
  body[29] = 1;
  return body;
}

// ---------------------------------------------------------------- one link cycle

async function runLink(link, writer) {
  await sleep(200); // the real dash takes a moment before dialling back
  log('link', `dialling back to phone at ${link.phoneHost}`);

  // ---- connection A: CAR_CTRL
  const a = new ControlConn(link, 'ctrl-A', await link.dial(cfg.controlPort, 'ctrl-A'));
  a.send(CMD.SELECT_CAR_CTRL);
  await a.expect(CMD.SELECT_CAR_CTRL + 1, 'CAR_CTRL select acked');
  pass('CAR_CTRL select acked', `${hex(CMD.SELECT_CAR_CTRL + 1)}`);

  const dashInfo = dashClientInfo();
  a.send(CMD.CLIENT_INFO, dashInfo);
  const infoReply = await a.expect(CMD.CLIENT_INFO + 1, 'CLIENT_INFO reply');
  validateClientInfoReply(infoReply, dashInfo.HUID);

  a.send(CMD.QUERY_SPEED);
  await a.expect(CMD.QUERY_SPEED + 1, 'QUERY_SPEED acked');
  pass('QUERY_SPEED acked', hex(CMD.QUERY_SPEED + 1));

  // ---- connection B: CAR_DATA
  const b = new ControlConn(link, 'ctrl-B', await link.dial(cfg.controlPort, 'ctrl-B'));
  b.send(CMD.SELECT_CAR_DATA);
  await b.expect(CMD.SELECT_CAR_DATA + 1, 'CAR_DATA select acked');
  pass('CAR_DATA select acked', hex(CMD.SELECT_CAR_DATA + 1));

  b.send(CMD.CHECK_SN, { sn: opt.serial, client_set: 'easy_conn' });
  const snAck = await b.expect(CMD.CHECK_SN + 1, 'CHECK_SN acked');
  pass('CHECK_SN acked', hex(CMD.CHECK_SN + 1));
  const snResult = await b.expect(CMD.CHECK_SN_RESULT, 'CHECK_SN_RESULT received');
  if (snResult.seq < snAck.seq) warn('CHECK_SN order', 'CHECK_SN_RESULT arrived before the 0x103e1 ack');
  const sn = parseJson(snResult.payload);
  check(
    !!sn && sn.isOk === true && (sn.id === opt.serial || sn.sn === opt.serial),
    'CHECK_SN_RESULT isOk and echoes the serial',
    sn && `isOk ${sn.isOk}, id ${sn.id}`,
    `payload ${snResult.payload.toString('utf8').slice(0, 160)}`,
  );
  b.send(CMD.CHECK_SN_RESULT + 1);

  const controls = [a, b];
  startControlTimers(link, controls);

  // ---- newer dashes: notify burst and clock sync before any media
  let timeSync = null;
  if (cfg.profile === 'cfdl26') {
    await notifyBurst(a);
    timeSync = startTimeSync(link, a);
  }

  // ---- media control (10921)
  const m = new MediaConn(link, 'media', await link.dial(cfg.mediaControlPort, 'media'));
  m.send(MEDIA.CONFIG_CAPTURE, captureBody());
  const capture = await m.expect(MEDIA.CONFIG_CAPTURE_REPLY, 'CONFIG_CAPTURE reply');
  const negotiated = validateCaptureReply(capture);

  m.send(MEDIA.GET_VERSION);
  const version = await m.expect(MEDIA.GET_VERSION_REPLY, 'GET_VERSION reply');
  const v = version.body.length >= 8 ? [version.body.readInt32LE(0), version.body.readInt32LE(4)] : null;
  check(v && v[0] === 3 && v[1] === 1, 'GET_VERSION reply is 3,1', v && `${v[0]},${v[1]}`, `body ${version.body.toString('hex')}`);

  m.send(MEDIA.CONFIG_EXTEND, Buffer.from('{"extend":0}'));
  const extend = await m.expect(MEDIA.CONFIG_EXTEND_REPLY, 'CONFIG_EXTEND reply');
  const ej = parseJson(extend.body);
  check(ej && ej.state === 0, 'CONFIG_EXTEND reply is {"state":0}', extend.body.toString('utf8'), `body ${JSON.stringify(extend.body.toString('utf8'))}`);

  m.send(MEDIA.HEARTBEAT);
  await m.expect(MEDIA.HEARTBEAT_REPLY, 'media heartbeat answered');
  pass('media heartbeat answered', '64 -> 65');
  const mediaBeats = startMediaHeartbeat(link, m);

  m.send(MEDIA.DATA_START);
  await m.expect(MEDIA.DATA_START_REPLY, 'DATA_START acked');
  pass('DATA_START acked', '112 -> 113');

  // ---- media data (10920): strict pull
  const stream = new StreamValidator(negotiated.width, negotiated.height);
  const pullSocket = await link.dial(cfg.mediaDataPort, 'video');
  startPulling(link, pullSocket, stream, writer, dashInfo.socketTimeoutPeriodWifi);

  link.finishers.push(
    () => stream.summarise(),
    () => mediaBeats.summarise(),
    () => timeSync?.summarise(),
    () => summariseControlBeats(controls),
  );
  await sleep((cfg.dropAfter ?? cfg.duration) * 1000);
}

function validateClientInfoReply(frame, huid) {
  const json = parseJson(frame.payload);
  if (!json) fatal('CLIENT_INFO reply is JSON', `payload ${JSON.stringify(frame.payload.toString('utf8').slice(0, 120))}`);
  const required = ['pxcVersion', 'phoneUUID', 'phoneOs', 'package', 'versionCode', 'pubkey', 'encryptedHUID', 'supportFunction'];
  const expected = ['phoneBrand', 'phoneModel', 'phoneOsVersion', 'token', 'bluetoothName', 'supportH264IFrame', 'appVersionFingerPrint'];
  const missing = required.filter((k) => !(k in json));
  check(missing.length === 0, 'CLIENT_INFO reply has required keys', required.join(', '), `missing ${missing.join(', ')}`);
  const missingSoft = expected.filter((k) => !(k in json));
  if (missingSoft.length) warn('CLIENT_INFO reply has the usual keys', `missing ${missingSoft.join(', ')}`);
  info('phone identity', `phoneOs=${json.phoneOs} package=${json.package} versionCode=${json.versionCode} supportFunction=${json.supportFunction}`);

  const pub = json.pubkey;
  let key = null;
  if (typeof pub !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(pub)) {
    fail('pubkey is base64 X.509 SubjectPublicKeyInfo RSA', `not a single-line base64 string: ${JSON.stringify(String(pub).slice(0, 40))}`);
  } else {
    try {
      key = crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' });
    } catch (error) {
      fail('pubkey is base64 X.509 SubjectPublicKeyInfo RSA', `DER does not parse as SubjectPublicKeyInfo (${error.message}); a bare PKCS#1 key?`);
    }
    if (key) {
      if (key.asymmetricKeyType !== 'rsa') {
        fail('pubkey is base64 X.509 SubjectPublicKeyInfo RSA', `key type ${key.asymmetricKeyType}`);
        key = null;
      } else {
        const bits = key.asymmetricKeyDetails?.modulusLength;
        pass('pubkey is base64 X.509 SubjectPublicKeyInfo RSA', `RSA-${bits}`);
        if (bits !== 1024) warn('pubkey size', `RSA-${bits}; the reference implementations use 1024`);
      }
    }
  }

  const enc = json.encryptedHUID;
  if (typeof enc !== 'string' || !enc) {
    fail('encryptedHUID verifies against pubkey', 'encryptedHUID is empty although the dash sent a HUID');
  } else if (key) {
    let plain = null;
    let why = '';
    try {
      plain = crypto.publicDecrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(enc, 'base64')).toString('utf8');
    } catch (error) {
      why = `RSA public-key decrypt failed (${error.message})`;
    }
    check(
      plain === huid,
      'encryptedHUID verifies against pubkey',
      `RSA PKCS#1 public decrypt yields "${huid}"`,
      `encryptedHUID does not verify: ${why || `decrypts to ${JSON.stringify(plain)}, expected ${JSON.stringify(huid)}`}`,
    );
  }
}

function validateCaptureReply(frame) {
  const body = frame.body;
  const expectW = cfg.panelW & ~15;
  const expectH = cfg.panelH & ~15;
  if (body.length < 9) fatal('CONFIG_CAPTURE reply is 9 bytes', `got ${body.length} bytes: ${body.toString('hex')}`);
  if (body.length !== 9) warn('CONFIG_CAPTURE reply is 9 bytes', `got ${body.length}`);
  else pass('CONFIG_CAPTURE reply is 9 bytes');
  const encoder = body.readInt32LE(0);
  const width = body.readInt16LE(4);
  const height = body.readInt16LE(6);
  const flag = body[8];
  check(encoder === 2, 'CONFIG_CAPTURE encoder is 2 (H.264)', `${encoder}`);
  check(
    width === expectW && height === expectH,
    'CONFIG_CAPTURE size rounded down to a multiple of 16',
    `${cfg.panelW}x${cfg.panelH} -> ${width}x${height}`,
    `phone replied ${width}x${height} for panel ${cfg.panelW}x${cfg.panelH}; expected ${expectW}x${expectH} (each side rounded down to a multiple of 16)`,
  );
  check(flag === 1, 'CONFIG_CAPTURE extend flag echoed', `${flag}`, `got ${flag}, sent 1 at body[29]`);
  return { width, height };
}

async function notifyBurst(a) {
  const burst = [
    [CMD.LOG_REPORT, { logLevel: 0, enable: false }],
    [CMD.OTA_FTP_INFO, { ip: '192.168.0.1', port: 21, path: '/ota' }],
    [CMD.MEDIA_FEATURE_CFG, { supportVideo: true, supportAudio: false }],
    [CMD.NOTIFY_10040, {}],
    [CMD.NOTIFY_10460, {}],
    [CMD.HU_QUERY_TIME, {}],
  ];
  // Payload contents are not in our notes; the only rule is that each is acked with cmd+1.
  for (const [cmd, payload] of burst) a.send(cmd, payload);
  const acks = await Promise.all(burst.map(([cmd]) => a.wait(cmd + 1, 3000)));
  const missing = burst.filter((_, i) => !acks[i]).map(([cmd]) => cmd);
  for (const [cmd] of burst) {
    if (!missing.includes(cmd)) pass(`notify ${hex(cmd)} acked`, hex(cmd + 1));
  }
  if (missing.length) {
    fatal(
      'notify burst acked',
      missing.map((cmd) => `${cmdName(cmd)} not acked with ${hex(cmd + 1)} within 3 s`).join('; ') +
        '; a cfdl26 dash never opens the media ports',
    );
  }
}

function startTimeSync(link, a) {
  const pending = new Map();
  let seq = 0;
  let clockOffsetMs = null; // null = dash clock unset (boots at 1970)
  const failed = new Set();
  let good = 0;
  let wroteTime = false;
  const onceFail = (key, name, detail) => {
    if (failed.has(key)) return;
    failed.add(key);
    fail(name, detail);
  };

  a.intercepts.push((frame) => {
    if (frame.cmd !== CMD.HU_TIME_SYNC + 1) return false;
    const body = frame.payload;
    if (body.length === 0) {
      onceFail('empty', 'time sync reply well formed', 'empty 0x10601 reply: a real dash resets its clock to 1970 on this');
      pending.clear();
      return true;
    }
    if (body.length !== 45) {
      onceFail('len', 'time sync reply well formed', `0x10601 body is ${body.length} bytes, expected 45`);
      return true;
    }
    const replySeq = body.readInt32LE(8);
    const sent = pending.get(replySeq);
    const text = body.subarray(16, 45).toString('latin1');
    const problems = [];
    if (body.readInt32LE(0) !== -2) problems.push(`word0 ${body.readInt32LE(0)}, expected -2`);
    if (body.readInt32LE(4) !== TIME_SYNC_CHANNEL) problems.push(`channel ${body.readInt32LE(4)}, expected ${TIME_SYNC_CHANNEL}`);
    if (!sent) problems.push(`seq ${replySeq} was never sent (or answered twice)`);
    if (body.readInt32LE(12) !== 0) problems.push(`word3 ${body.readInt32LE(12)}, expected 0`);
    const when = parseStamp(text);
    if (!when) problems.push(`timestamp ${JSON.stringify(text)} is not yyyy-MM-dd HH:mm:ss.SSS000000`);
    if (problems.length) {
      onceFail('shape', 'time sync reply well formed', problems.join('; '));
      if (sent) pending.delete(replySeq);
      return true;
    }
    pending.delete(replySeq);
    good++;
    if (sent.unset) {
      const skew = Math.abs(when.getTime() - Date.now());
      if (when.getFullYear() !== 1970 && skew < 120_000) {
        if (!wroteTime) pass('phone writes current time into an unset (1970) dash clock', `${text} (skew ${skew} ms)`);
        wroteTime = true;
        clockOffsetMs = when.getTime() - Date.now();
      } else {
        onceFail('unset', 'phone writes current time into an unset (1970) dash clock', `reply carried ${text}`);
      }
    } else if (text !== sent.text) {
      const skew = Math.abs(when.getTime() - Date.now());
      if (skew > 120_000) onceFail('echo', 'time sync echoes a set clock', `sent ${sent.text}, got ${text}`);
    }
    return true;
  });

  const tick = () => {
    const unset = clockOffsetMs === null;
    const text = unset ? UNSET_CLOCK : dashStamp(new Date(Date.now() + clockOffsetMs));
    const s = seq++;
    pending.set(s, { text, unset, at: Date.now() });
    if (opt.verbose) log('ctrl-A', `-> HU_TIME_SYNC seq ${s} ${text}`);
    a.socket.write(encodeControl(CMD.HU_TIME_SYNC, timeSyncBody(s, text)));
  };
  tick();
  link.every(2000, tick);

  return {
    summarise() {
      const stale = [...pending.entries()].filter(([, p]) => Date.now() - p.at > 3000);
      if (stale.length) fail('every time sync answered', `seq ${stale.map(([s]) => s).join(', ')} unanswered after 3 s`);
      if (!failed.size && good > 0) pass('time sync reply well formed', `${good} replies, 45 bytes, header echoed`);
      if (!wroteTime && !failed.has('unset') && !failed.has('empty')) fail('phone writes current time into an unset (1970) dash clock', 'no reply to the 1970 sync');
    },
  };
}

function startControlTimers(link, controls) {
  if (opt['strict-heartbeat']) {
    for (const c of controls) c.lastPhoneBeat = Date.now();
    link.every(250, () => {
      for (const c of controls) {
        if (Date.now() - c.lastPhoneBeat > 7000) {
          link.drop('strict heartbeat', `no phone heartbeat on ${c.name} for 7 s; an sdk 0.9.23 dash drops the link here`);
          return;
        }
      }
    });
  }
  if (opt['dash-heartbeat']) {
    link.every(2000, () => {
      for (const c of controls) {
        c.dashBeatsSent++;
        c.socket.write(encodeControl(CMD.HEARTBEAT));
      }
    });
  }
}

function summariseControlBeats(controls) {
  for (const c of controls) {
    const gap = Math.max(c.maxBeatGapMs, Date.now() - c.lastPhoneBeat);
    const detail = `${c.phoneBeats} received, largest gap ${(gap / 1000).toFixed(1)} s`;
    if (opt['strict-heartbeat']) pass(`phone heartbeats on ${c.name}`, detail);
    else if (gap > 7000) warn(`phone heartbeats on ${c.name}`, `${detail}; an sdk 0.9.23 dash would have dropped the link`);
    else info(`phone heartbeats on ${c.name}`, detail);
    if (opt['dash-heartbeat']) {
      check(
        c.dashBeatAcks >= c.dashBeatsSent - 1,
        `phone answers dash heartbeats on ${c.name}`,
        `${c.dashBeatAcks}/${c.dashBeatsSent} acked`,
      );
    }
  }
}

function startMediaHeartbeat(link, m) {
  const pending = [];
  let sent = 0;
  let answered = 0;
  m.intercepts.push((frame) => {
    if (frame.type !== MEDIA.HEARTBEAT_REPLY) return false;
    pending.shift();
    answered++;
    return true;
  });
  link.every(1000, () => {
    sent++;
    pending.push(Date.now());
    m.send(MEDIA.HEARTBEAT);
  });
  return {
    summarise() {
      const late = pending.filter((at) => Date.now() - at > 3000).length;
      check(late === 0, 'media heartbeats answered', `${answered}/${sent} answered`, `${late} of ${sent} unanswered after 3 s`);
    },
  };
}

function startPulling(link, socket, stream, writer, socketTimeoutSec) {
  const interval = 1000 / cfg.pullFps;
  const frameTimeout = cfg.frameTimeout ?? socketTimeoutSec;
  const repullMs = 2000;
  let buf = Buffer.alloc(0);
  let outstanding = 0;
  let lastPullAt = 0;
  let lastFrameAt = Date.now();
  let pulls = 0;
  let repulls = 0;

  const pull = () => {
    socket.write(encodeMedia(MEDIA.DATA_NEXT));
    outstanding++;
    pulls++;
    lastPullAt = Date.now();
  };

  socket.on('error', () => {});
  socket.on('close', () => link.drop('video connection', 'phone closed the media data connection'));
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const size = buf.readInt32LE(0);
      if (size <= 0 || size > MAX_ACCESS_UNIT) {
        link.drop('video framing', `pull reply length ${size} is not a sane access-unit size; stream out of sync (first bytes ${buf.subarray(0, 8).toString('hex')})`);
        return;
      }
      if (buf.length < 4 + size) break;
      const au = Buffer.from(buf.subarray(4, 4 + size));
      buf = buf.subarray(4 + size);
      lastFrameAt = Date.now();
      outstanding = Math.max(0, outstanding - 1);
      if (opt.verbose) {
        log('video', `<- frame #${stream.count} ${size} B`);
        hexdump(au, 32);
      }
      stream.add(au);
      if (writer) {
        writer.write(au);
        framesWritten++;
      }
      if (outstanding === 0) link.after(Math.max(0, lastPullAt + interval - Date.now()), () => outstanding === 0 && pull());
    }
  });

  link.every(250, () => {
    if (Date.now() - lastFrameAt > frameTimeout * 1000) {
      link.drop('video keeps flowing', `no video frame for ${frameTimeout} s (socketTimeoutPeriodWifi); a real dash drops the link here`);
      return;
    }
    // The phone answers nothing when it has no frame ready within 1.5 s, so a
    // pull can be swallowed; ask again rather than stall forever.
    if (outstanding > 0 && Date.now() - lastPullAt > repullMs) {
      repulls++;
      outstanding = 0;
      pull();
    }
  });
  link.finishers.push(() => info('pulls', `${pulls} sent, ${repulls} re-sent after ${repullMs} ms without an answer`));
  log('video', `pulling at ${cfg.pullFps} fps, no-frame timeout ${frameTimeout} s`);
  pull();
}

// ---------------------------------------------------------------- main

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
}

async function postProcess(streamPath, framesTotal) {
  if (!streamPath || framesTotal === 0) return;
  currentCycle = 0;
  if (!hasFfmpeg()) {
    if (opt.out) info('stream written', `${streamPath}; view with "ffplay -f h264 ${streamPath}" or open it in VLC`);
    if (opt.snapshot) warn('snapshot', 'ffmpeg not on PATH; install it (brew install ffmpeg) or open the .h264 in VLC');
    return;
  }
  const decode = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'h264', '-i', streamPath, '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const errors = (decode.stderr ?? '').trim();
  check(
    decode.status === 0 && !errors,
    'ffmpeg decodes the stream without errors',
    `${framesTotal} frames`,
    errors.split('\n').slice(0, 3).join(' | ') || `ffmpeg exit ${decode.status}`,
  );
  if (opt.out) info('stream written', `${streamPath} (ffplay -f h264 ${streamPath})`);
  if (opt.snapshot) {
    const pick = Math.min(24, framesTotal - 1);
    const shot = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-v', 'error', '-y', '-f', 'h264', '-i', streamPath, '-vf', `select=eq(n\\,${pick})`, '-frames:v', '1', opt.snapshot],
      { encoding: 'utf8' },
    );
    const ok = shot.status === 0 && fs.existsSync(opt.snapshot);
    if (ok) info('snapshot', `frame ${pick} -> ${opt.snapshot}`);
    else warn('snapshot', (shot.stderr ?? '').trim().split('\n')[0] || 'ffmpeg failed');
  }
}

function printSummary() {
  const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 };
  for (const c of checks) counts[c.status]++;
  const width = Math.min(60, Math.max(...checks.map((c) => c.name.length), 10));
  out.write(`\n${'='.repeat(100)}\nSUMMARY\n${'='.repeat(100)}\n`);
  out.write(` #   cyc  status  ${'check'.padEnd(width)}  detail\n`);
  checks.forEach((c, i) => {
    const detail = c.detail.length > 110 ? `${c.detail.slice(0, 107)}...` : c.detail;
    out.write(
      `${String(i + 1).padStart(3)}  ${String(c.cycle || '-').padStart(3)}  ${c.status.padEnd(6)}  ${c.name.padEnd(width)}  ${detail}\n`,
    );
  });
  const ok = counts.FAIL === 0 && counts.PASS > 0;
  out.write(
    `\nRESULT: ${ok ? 'PASS' : 'FAIL'}  (${counts.PASS} passed, ${counts.FAIL} failed, ${counts.WARN} warnings)\n`,
  );
  return { ok, counts };
}

async function main() {
  const probe = new ProbeServer();
  try {
    await probe.start();
  } catch (error) {
    process.stderr.write(`cannot listen on ${cfg.bind}:${cfg.probePort}: ${error.code ?? error.message}\n`);
    return 2;
  }
  log(
    'dash',
    `profile ${cfg.profile}, panel ${cfg.panelW}x${cfg.panelH}@${cfg.fps}, phone ports ${cfg.controlPort}/${cfg.mediaControlPort}/${cfg.mediaDataPort}` +
      `${opt['strict-heartbeat'] ? ', strict heartbeat' : ''}${cfg.dropAfter ? `, ignition cycle every ${cfg.dropAfter} s x${cfg.cycles}` : ''}`,
  );

  const streamPath = opt.out ?? (opt.snapshot ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sim-')), 'stream.h264') : null);
  const writer = streamPath ? fs.createWriteStream(streamPath) : null;
  const cycles = [];

  for (let cycle = 1; cycle <= cfg.cycles; cycle++) {
    currentCycle = cycle;
    log('dash', cycle === 1 ? 'waiting for the phone to probe' : 'IGNITION ON: waiting for the phone to probe again');
    const got = await probe.next(cycle === 1 ? cfg.probeTimeout : cfg.reconnectTimeout);
    if (!got) {
      fail(
        cycle === 1 ? 'probe received' : 'phone re-probes after an ignition cycle',
        `no probe on :${cfg.probePort} within ${cycle === 1 ? cfg.probeTimeout : cfg.reconnectTimeout} s`,
      );
      break;
    }
    if (!got.ok) break;

    const link = new Link(got.host);
    link.finishers = [];
    let linked = false;
    try {
      await link.guard(runLink(link, writer));
      linked = true;
    } catch (error) {
      if (!(error instanceof Fatal)) fail('simulator error', String(error?.stack ?? error));
    }
    for (const finish of link.finishers ?? []) finish();
    link.close();
    cycles.push({ cycle, linked, reason: link.dropReason ?? null });
    if (!linked) break;
    if (cycle < cfg.cycles) {
      log('dash', `IGNITION OFF: all sockets closed, dark for ${cfg.offTime} s`);
      await probe.stop();
      await sleep(cfg.offTime * 1000);
      await probe.start();
    }
  }
  await probe.stop();

  if (writer) await new Promise((resolve) => writer.end(resolve));
  await postProcess(streamPath, framesWritten);

  const { ok, counts } = printSummary();
  if (opt.json) {
    process.stdout.write(
      `${JSON.stringify({ ok, profile: cfg.profile, panel: `${cfg.panelW}x${cfg.panelH}`, counts, cycles, checks })}\n`,
    );
  }
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(2);
  },
);
