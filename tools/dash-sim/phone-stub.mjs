#!/usr/bin/env node
/**
 * Minimal fake PHONE, used only to test dash-sim.mjs against itself.
 *
 * It listens on the three phone ports, probes the simulated dash, answers the
 * handshake by the same rules the app follows (src/protocol), and serves a
 * synthetic H.264 Baseline stream on the pull port. --fault injects one known
 * mistake so test.mjs can check that the simulator catches it.
 *
 * Its framing code is written separately from dash-sim.mjs on purpose: a bug
 * shared by both would make them agree with each other and prove nothing.
 *
 * Faults:
 *   bad-magic        probe header carries a wrong XOR magic
 *   no-notify-ack    never acks notify 0x10040 (cfdl26 burst)
 *   bad-huid         encryptedHUID signed over the wrong bytes
 *   p-frame-first    first frame after DATA_START is a P-frame without SPS/PPS
 *   no-round16       CONFIG_CAPTURE reply keeps the panel size unrounded
 *   no-frames        never answers a frame pull
 *   empty-timesync   answers 0x10600 with an empty 0x10601
 *   no-heartbeat     sends no phone heartbeats
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';

const { values: opt } = parseArgs({
  options: {
    dash: { type: 'string', default: '127.0.0.1' },
    'probe-port': { type: 'string', default: '10930' },
    'control-port': { type: 'string', default: '10922' },
    'media-control-port': { type: 'string', default: '10921' },
    'media-data-port': { type: 'string', default: '10920' },
    fault: { type: 'string', default: '' },
    synthetic: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
});

const faults = new Set(opt.fault.split(',').filter(Boolean));
const ports = {
  probe: Number(opt['probe-port']),
  control: Number(opt['control-port']),
  mediaControl: Number(opt['media-control-port']),
  mediaData: Number(opt['media-data-port']),
};

const say = (msg) => opt.verbose && process.stderr.write(`[phone-stub] ${msg}\n`);

// ------------------------------------------------------------------ framing

function ctrl(cmd, body) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const len = 16 + payload.length;
  const h = Buffer.alloc(16);
  h.writeUInt32LE(cmd, 0);
  h.writeUInt32LE(len, 4);
  let magic = (cmd ^ len) >>> 0;
  if (faults.has('bad-magic') && cmd === 0x70000010) magic ^= 0x5a5a;
  h.writeUInt32LE(magic, 8);
  return Buffer.concat([h, payload]);
}

function media(type, body = Buffer.alloc(0)) {
  const h = Buffer.alloc(8);
  h.writeInt16LE(type, 0);
  h.writeUInt16LE(body.length, 2);
  return Buffer.concat([h, body]);
}

/** Splits a byte stream into frames given a header size and a length reader. */
function framer(headerSize, totalOf, onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= headerSize) {
      const total = totalOf(buf);
      if (buf.length < total) return;
      onFrame(buf.subarray(0, total));
      buf = buf.subarray(total);
    }
  };
}

// ------------------------------------------------------------------ identity

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const pubkeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

// ------------------------------------------------------------------ H.264 source

class Bits {
  bits = [];
  u(n, v) {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2);
  }
  ue(v) {
    const len = (v + 1).toString(2).length;
    this.u(len - 1, 0);
    this.u(len, v + 1);
  }
  se(v) {
    this.ue(v > 0 ? 2 * v - 1 : -2 * v);
  }
  trailing() {
    this.bits.push(1);
    while (this.bits.length % 8) this.bits.push(0);
  }
  bytes() {
    const out = Buffer.alloc(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
}

function nal(header, rbsp) {
  const out = [0, 0, 0, 1, header];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros === 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

/**
 * Builds a valid Constrained Baseline stream with no encoder at all: the IDR is
 * all I_16x16 DC macroblocks with no residual (a flat grey picture), the
 * P-frames are a single skip run. CAVLC, POC type 2, deblocking off.
 */
function syntheticStream(width, height, frames = 48, gop = 24) {
  const mbW = Math.ceil(width / 16);
  const mbH = Math.ceil(height / 16);
  const mbs = mbW * mbH;

  const sps = new Bits();
  sps.u(8, 66); // profile_idc Baseline
  sps.u(8, 0xc0); // constraint_set0 + constraint_set1
  sps.u(8, 31); // level 3.1
  sps.ue(0); // sps id
  sps.ue(0); // log2_max_frame_num_minus4 -> 16
  sps.ue(2); // pic_order_cnt_type 2
  sps.ue(1); // max_num_ref_frames
  sps.u(1, 0);
  sps.ue(mbW - 1);
  sps.ue(mbH - 1);
  sps.u(1, 1); // frame_mbs_only
  sps.u(1, 1); // direct_8x8_inference
  const cropR = (mbW * 16 - width) / 2;
  const cropB = (mbH * 16 - height) / 2;
  if (cropR || cropB) {
    sps.u(1, 1);
    sps.ue(0);
    sps.ue(cropR);
    sps.ue(0);
    sps.ue(cropB);
  } else sps.u(1, 0);
  sps.u(1, 0); // no VUI
  sps.trailing();

  const pps = new Bits();
  pps.ue(0);
  pps.ue(0);
  pps.u(1, 0); // CAVLC
  pps.u(1, 0);
  pps.ue(0); // one slice group
  pps.ue(0);
  pps.ue(0);
  pps.u(1, 0);
  pps.u(2, 0);
  pps.se(0);
  pps.se(0);
  pps.se(0);
  pps.u(1, 1); // deblocking_filter_control_present
  pps.u(1, 0);
  pps.u(1, 0);
  pps.trailing();

  const spsNal = nal(0x67, sps.bytes());
  const ppsNal = nal(0x68, pps.bytes());
  const units = [];
  let idrId = 0;
  for (let i = 0; i < frames; i++) {
    const n = i % gop;
    const s = new Bits();
    s.ue(0); // first_mb_in_slice
    if (n === 0) {
      s.ue(7); // I
      s.ue(0);
      s.u(4, 0); // frame_num
      s.ue(idrId++ % 2);
      s.u(1, 0); // no_output_of_prior_pics
      s.u(1, 0); // long_term_reference
      s.se(0); // slice_qp_delta
      s.ue(1); // deblocking off
      for (let m = 0; m < mbs; m++) {
        s.ue(3); // I_16x16_2_0_0 (DC prediction, no coded residual)
        s.ue(0); // intra_chroma_pred_mode DC
        s.se(0); // mb_qp_delta
        s.u(1, 1); // coeff_token TotalCoeff 0 for the luma DC block (nC 0)
      }
      s.trailing();
      units.push(Buffer.concat([spsNal, ppsNal, nal(0x65, s.bytes())]));
    } else {
      s.ue(5); // P
      s.ue(0);
      s.u(4, n % 16);
      s.u(1, 0); // num_ref_idx_active_override
      s.u(1, 0); // ref_pic_list_modification_flag_l0
      s.u(1, 0); // adaptive_ref_pic_marking_mode
      s.se(0);
      s.ue(1);
      s.ue(mbs); // every macroblock skipped
      s.trailing();
      units.push(nal(0x41, s.bytes()));
    }
  }
  return units;
}

/** One access unit per picture: a new unit starts after every slice NAL (one slice per frame). */
function splitAccessUnits(stream) {
  const starts = [];
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      starts.push(i > 0 && stream[i - 1] === 0 ? i - 1 : i);
      i += 2;
    }
  }
  const units = [];
  let current = [];
  for (let k = 0; k < starts.length; k++) {
    const piece = stream.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : stream.length);
    const offset = piece[2] === 1 ? 3 : 4;
    const type = piece[offset] & 0x1f;
    current.push(piece);
    if (type === 1 || type === 5) {
      units.push(Buffer.concat(current));
      current = [];
    }
  }
  return units;
}

function ffmpegStream(width, height) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=24`,
      '-frames:v', '48', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1',
      '-g', '24', '-bf', '0', '-x264-params', 'slices=1:sliced-threads=0', '-f', 'h264', '-',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      const units = code === 0 ? splitAccessUnits(Buffer.concat(chunks)) : [];
      units.length ? resolve(units) : reject(new Error(`ffmpeg exit ${code}`));
    });
  });
}

const streams = new Map();
function getStream(width, height) {
  const key = `${width}x${height}`;
  if (!streams.has(key)) {
    const made = opt.synthetic
      ? Promise.resolve(syntheticStream(width, height))
      : ffmpegStream(width, height).catch((error) => {
          say(`ffmpeg unavailable (${error.message}); using the synthetic stream`);
          return syntheticStream(width, height);
        });
    streams.set(key, made);
  }
  return streams.get(key);
}

// ------------------------------------------------------------------ session state

let open = 0;
let linked = false;
let video = { width: 0, height: 0, units: null, next: 0 };

function track(socket, port) {
  open++;
  linked = true;
  socket.setNoDelay(true);
  socket.on('error', () => {});
  socket.on('close', () => {
    open--;
    say(`closed :${port} (${open} left)`);
    // Like the app: once every dash connection is gone, start probing again.
    if (open === 0 && linked) {
      linked = false;
      setTimeout(probeLoop, 300);
    }
  });
}

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000000`;
}

function timeSyncReply(req) {
  if (faults.has('empty-timesync')) return Buffer.alloc(0);
  const reply = Buffer.from(req);
  const text = reply.subarray(16, 45).toString('latin1');
  const year = Number(text.slice(0, 4));
  if (!/^\d{4}-\d\d-\d\d/.test(text) || (year >= 1969 && year <= 1971)) reply.write(nowStamp(), 16, 29, 'latin1');
  return reply;
}

function onControl(socket) {
  track(socket, ports.control);
  if (!faults.has('no-heartbeat')) {
    const beat = setInterval(() => socket.write(ctrl(0x70000000)), 2000);
    socket.on('close', () => clearInterval(beat));
  }
  socket.on(
    'data',
    framer(16, (b) => b.readUInt32LE(4), (frame) => {
      const cmd = frame.readUInt32LE(0);
      const body = frame.subarray(16);
      say(`ctrl <- 0x${cmd.toString(16)}`);
      if ((cmd & 0xf) === 1) return; // replies need no answer
      if (cmd === 0x10010) {
        const info = JSON.parse(body.toString());
        const signed = faults.has('bad-huid') ? `${info.HUID}-tampered` : info.HUID;
        const enc = crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(signed));
        socket.write(
          ctrl(0x10011, {
            pxcVersion: '1.0.2',
            phoneUUID: crypto.randomUUID(),
            phoneBrand: 'Apple',
            phoneModel: 'iPhone',
            phoneOsVersion: '35',
            phoneOs: 'Android',
            package: 'com.cfmoto.cfmotointernational',
            versionCode: 126,
            token: 0,
            pubkey: pubkeyB64,
            encryptedHUID: enc.toString('base64'),
            bluetoothName: 'phone-stub',
            supportH264IFrame: true,
            supportFunction: 0,
            supportSyncCorrectTime: false,
            appVersionFingerPrint: 'phone-stub',
          }),
        );
        return;
      }
      if (cmd === 0x103e0) {
        const req = JSON.parse(body.toString() || '{}');
        socket.write(ctrl(0x103e1));
        socket.write(ctrl(0x201c0, { isOk: true, errCode: 0, errMsg: '', id: req.sn ?? '', client_set: req.client_set ?? 'easy_conn' }));
        return;
      }
      if (cmd === 0x10600) {
        socket.write(ctrl(0x10601, timeSyncReply(body)));
        return;
      }
      if (cmd === 0x10040 && faults.has('no-notify-ack')) return;
      socket.write(ctrl(cmd + 1));
    }),
  );
}

function onMediaControl(socket) {
  track(socket, ports.mediaControl);
  socket.on(
    'data',
    framer(8, (b) => 8 + b.readUInt16LE(2), (frame) => {
      const type = frame.readInt16LE(0);
      const body = frame.subarray(8);
      say(`media <- ${type}`);
      switch (type) {
        case 16: {
          const w = body.readInt16LE(0);
          const h = body.readInt16LE(2);
          const want = body.readInt32LE(8);
          const width = faults.has('no-round16') ? w : w - (w % 16);
          const height = faults.has('no-round16') ? h : h - (h % 16);
          video = { width, height, units: null, next: 0 };
          getStream(width, height).then((units) => {
            if (video.width === width && video.height === height) video.units = units;
          });
          const reply = Buffer.alloc(9);
          reply.writeInt32LE(want || 2, 0);
          reply.writeInt16LE(width, 4);
          reply.writeInt16LE(height, 6);
          reply[8] = body.length > 29 ? body[29] : 0;
          socket.write(media(17, reply));
          break;
        }
        case 48: {
          const v = Buffer.alloc(8);
          v.writeInt32LE(3, 0);
          v.writeInt32LE(1, 4);
          socket.write(media(49, v));
          break;
        }
        case 64:
          socket.write(media(65));
          break;
        case 96:
          socket.write(media(97, Buffer.from('{"state":0}')));
          break;
        case 112:
          // Restart at a keyframe, unless the fault says to start mid-GOP.
          video.next = faults.has('p-frame-first') ? 1 : 0;
          socket.write(media(113));
          break;
        case 128:
          socket.write(media(129));
          break;
      }
    }),
  );
}

function onMediaData(socket) {
  track(socket, ports.mediaData);
  let queue = Promise.resolve();
  socket.on(
    'data',
    framer(8, (b) => 8 + b.readUInt16LE(2), (frame) => {
      if (frame.readInt16LE(0) !== 114 || faults.has('no-frames')) return;
      // Strict pull: one access unit per request, in order.
      queue = queue.then(async () => {
        const units = video.units ?? (await getStream(video.width, video.height));
        video.units = units;
        const unit = units[video.next % units.length];
        video.next++;
        const size = Buffer.alloc(4);
        size.writeUInt32LE(unit.length, 0);
        if (!socket.destroyed) socket.write(Buffer.concat([size, unit]));
      });
    }),
  );
}

// ------------------------------------------------------------------ probe

let probing = false;
function probeLoop() {
  if (probing || linked) return;
  probing = true;
  const retry = () => {
    probing = false;
    setTimeout(probeLoop, 300);
  };
  const socket = net.connect({ host: opt.dash, port: ports.probe });
  socket.on('error', retry);
  socket.on('connect', () => {
    say('probe -> dash');
    socket.write(ctrl(0x70000010, { phoneType: 'Android', packageName: 'com.cfmoto.cfmotointernational' }));
  });
  socket.on(
    'data',
    framer(16, (b) => b.readUInt32LE(4), (frame) => {
      const ok = frame.readUInt32LE(0) === 0x70000011 && JSON.parse(frame.subarray(16).toString() || '{}').status === true;
      say(`probe reply ${ok ? 'accepted' : 'rejected'}`);
      socket.removeAllListeners('error');
      socket.on('error', () => {});
      socket.destroy();
      probing = false;
      // Re-probe if the dash does not dial back, as the app does.
      setTimeout(() => !linked && probeLoop(), ok ? 10_000 : 1000);
    }),
  );
  socket.on('close', () => {
    if (probing) retry();
  });
}

function listen(port, handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

await listen(ports.control, onControl);
await listen(ports.mediaControl, onMediaControl);
await listen(ports.mediaData, onMediaData);
say(`listening on ${ports.control}/${ports.mediaControl}/${ports.mediaData}, faults [${[...faults].join(',')}]`);
probeLoop();
