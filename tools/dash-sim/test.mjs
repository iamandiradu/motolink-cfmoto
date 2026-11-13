#!/usr/bin/env node
/**
 * Self-test for the dash simulator: runs dash-sim.mjs against phone-stub.mjs
 * on loopback, with non-default ports, and checks that the simulator passes a
 * correct phone and FAILS, with the right message, for each injected fault.
 *
 * A simulator that passes everything is worthless, so most cases here are
 * negative ones. Cases run in parallel on separate port blocks.
 *
 *   node tools/dash-sim/test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(here, 'dash-sim.mjs');
const STUB = path.join(here, 'phone-stub.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sim-test-'));

const CASES = [
  { name: 'correct phone (cfdl16)', sim: ['--duration', '2', '--out', path.join(tmp, 'ok.h264')], pass: true },
  {
    name: 'correct phone (cfdl26, strict heartbeat, dash heartbeat)',
    sim: ['--profile', 'cfdl26', '--strict-heartbeat', '--dash-heartbeat', '--duration', '3'],
    pass: true,
    mustInclude: [/phone writes current time into an unset \(1970\) dash clock/, /notify 0x10040 acked/],
  },
  {
    name: 'correct phone, synthetic stream, decoded by ffmpeg when present',
    sim: ['--duration', '2', '--out', path.join(tmp, 'synthetic.h264')],
    stub: ['--synthetic'],
    pass: true,
  },
  {
    name: 'ignition cycle: phone reconnects',
    sim: ['--drop-after', '1.5', '--off-time', '1', '--cycles', '2'],
    pass: true,
    mustInclude: [/cycle2:video frames received/],
  },
  { name: 'fault: wrong XOR magic in probe', stub: ['--fault', 'bad-magic'], failOn: /probe header.*bad XOR magic/ },
  {
    name: 'fault: notify 0x10040 not acked (cfdl26)',
    sim: ['--profile', 'cfdl26'],
    stub: ['--fault', 'no-notify-ack'],
    failOn: /notify burst acked.*0x10040.*not acked with 0x10041.*never opens the media ports/,
    mustNotInclude: [/CONFIG_CAPTURE/],
  },
  {
    name: 'fault: encryptedHUID does not verify',
    sim: ['--duration', '1'],
    stub: ['--fault', 'bad-huid'],
    failOn: /encryptedHUID verifies against pubkey.*encryptedHUID does not verify/,
  },
  {
    name: 'fault: first frame is a P-frame without SPS/PPS',
    sim: ['--duration', '1.5'],
    stub: ['--fault', 'p-frame-first'],
    failOn: /first frame after DATA_START is SPS\+PPS\+IDR.*P-frame without SPS\/PPS/,
  },
  {
    name: 'fault: capture size not rounded to 16',
    sim: ['--duration', '1'],
    stub: ['--fault', 'no-round16'],
    failOn: /rounded down to a multiple of 16.*replied 800x386/,
  },
  {
    name: 'fault: no frame for 9 s',
    sim: ['--duration', '15'],
    stub: ['--fault', 'no-frames'],
    failOn: /video keeps flowing.*no video frame for 9 s/,
  },
  {
    name: 'fault: empty time sync reply (cfdl26)',
    sim: ['--profile', 'cfdl26', '--duration', '2.5'],
    stub: ['--fault', 'empty-timesync'],
    failOn: /time sync reply well formed.*empty 0x10601/,
  },
  {
    name: 'fault: phone sends no heartbeat (strict)',
    sim: ['--strict-heartbeat', '--duration', '10'],
    stub: ['--fault', 'no-heartbeat'],
    failOn: /strict heartbeat.*no phone heartbeat on ctrl-A for 7 s/,
  },
];

function runCase(testCase, index) {
  const base = 23000 + index * 10;
  const ports = [
    '--probe-port', String(base),
    '--control-port', String(base + 2),
    '--media-control-port', String(base + 1),
    '--media-data-port', String(base + 3),
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const sim = spawn(process.execPath, [SIM, ...ports, '--bind', '127.0.0.1', '--probe-timeout', '15', '--json', ...(testCase.sim ?? [])]);
    let stdout = '';
    let log = '';
    sim.stdout.on('data', (d) => (stdout += d));
    sim.stderr.on('data', (d) => (log += d));
    // Start the phone once the simulator is listening for the probe.
    let stub = null;
    const startStub = () => {
      if (stub) return;
      stub = spawn(process.execPath, [STUB, '--dash', '127.0.0.1', ...ports, ...(testCase.stub ?? [])], { stdio: 'ignore' });
    };
    sim.stderr.on('data', () => /listening on/.test(log) && startStub());
    const killer = setTimeout(() => sim.kill('SIGKILL'), 45_000);
    sim.on('close', (code) => {
      clearTimeout(killer);
      stub?.kill();
      let result = null;
      try {
        result = JSON.parse(stdout.trim().split('\n').pop());
      } catch {}
      resolve({ testCase, code, result, log, seconds: (Date.now() - started) / 1000 });
    });
  });
}

function judge({ testCase, code, result }) {
  const problems = [];
  if (!result) return ['simulator printed no JSON result'];
  const lines = result.checks.map((c) => `cycle${c.cycle}:${c.name}: ${c.detail}`);
  const fails = result.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.name}: ${c.detail}`);
  if (testCase.pass) {
    if (code !== 0) problems.push(`exit code ${code}, expected 0`);
    if (!result.ok) problems.push('result.ok is false');
    for (const f of fails) problems.push(`unexpected FAIL ${f}`);
  } else {
    if (code !== 1) problems.push(`exit code ${code}, expected 1`);
    if (result.ok) problems.push('result.ok is true for a faulty phone');
    if (!fails.some((f) => testCase.failOn.test(f))) {
      problems.push(`no FAIL matching ${testCase.failOn}; FAILs were: ${fails.join(' | ') || 'none'}`);
    }
  }
  for (const re of testCase.mustInclude ?? []) if (!lines.some((l) => re.test(l))) problems.push(`no check matching ${re}`);
  for (const re of testCase.mustNotInclude ?? []) if (lines.some((l) => re.test(l))) problems.push(`unexpected check matching ${re}`);
  return problems;
}

const results = await Promise.all(CASES.map(runCase));
let failures = 0;
console.log('');
for (const r of results) {
  const problems = judge(r);
  const fails = r.result?.checks.filter((c) => c.status === 'FAIL') ?? [];
  const note = r.testCase.pass
    ? `${r.result?.counts.PASS ?? 0} checks passed`
    : `caught: ${fails.find((f) => r.testCase.failOn.test(`${f.name}: ${f.detail}`))?.detail ?? '-'}`;
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${r.testCase.name.padEnd(62)} ${r.seconds.toFixed(1).padStart(5)} s  ${note.slice(0, 110)}`);
  if (problems.length) {
    failures++;
    for (const p of problems) console.log(`        - ${p}`);
    console.log(`        simulator log (tail):\n${r.log.split('\n').slice(-25).map((l) => `          ${l}`).join('\n')}`);
  }
}
const okFile = path.join(tmp, 'ok.h264');
if (fs.existsSync(okFile)) console.log(`\nstream from the correct-phone run: ${okFile} (${fs.statSync(okFile).size} bytes)`);
console.log(`\n${failures ? `${failures} of ${results.length} cases FAILED` : `all ${results.length} cases passed`}`);
process.exit(failures ? 1 : 0);
