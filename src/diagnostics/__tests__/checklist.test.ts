import type { DashInfo } from '../../protocol/control';
import type { SessionSnapshot } from '../../protocol/session';
import { Checklist, ChecklistInput, StepId, buildChecklist, summary } from '../checklist';

const NOW = new Date(2026, 10, 13, 10, 5, 0).getTime();

const DASH: DashInfo = {
  huid: 'HU1234567890ABCDEF',
  name: 'CFMOTO',
  sdkVersion: '3.2.1',
  channel: null,
  supportScreenTouch: false,
  socketTimeoutSec: 7,
  raw: { sdkVersion: '3.2.1' },
};

const CAPTURE = { deviceWidth: 800, deviceHeight: 384, width: 800, height: 384, fps: 30 };

function snap(patch: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { state: 'idle', dash: null, capture: null, framesSent: 0, framesDropped: 0, lastError: null, ...patch };
}

function input(patch: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    paired: true,
    phoneIp: '192.168.0.12',
    dashAddress: '192.168.0.1',
    snapshot: snap(),
    mirroring: false,
    logs: [],
    now: NOW,
    ...patch,
  };
}

function statuses(list: Checklist): Record<StepId, string> {
  return Object.fromEntries(list.steps.map((s) => [s.id, s.status])) as Record<StepId, string>;
}

/** Exactly one active or failed step, all before it done/skipped, all after waiting. */
function expectStuckAt(list: Checklist, id: StepId, status: 'active' | 'failed') {
  const index = list.steps.findIndex((s) => s.id === id);
  expect(list.stuck).toBe(id);
  expect(list.steps.filter((s) => s.status === 'active' || s.status === 'failed')).toHaveLength(1);
  expect(list.steps[index].status).toBe(status);
  expect(list.steps[index].hint).toBeDefined();
  list.steps.slice(0, index).forEach((s) => expect(['done', 'skipped']).toContain(s.status));
  list.steps.slice(index + 1).forEach((s) => expect(s.status).toBe('waiting'));
  list.steps.filter((s) => s.id !== id).forEach((s) => expect(s.hint).toBeUndefined());
  return list.steps[index];
}

function hintText(list: Checklist): string {
  const step = list.steps.find((s) => s.id === list.stuck);
  return step?.hint ? [...step.hint.causes, ...step.hint.actions].join(' ') : '';
}

describe('buildChecklist', () => {
  it('starts at pairing when no bike is saved', () => {
    const list = buildChecklist(input({ paired: false, phoneIp: null }));
    expectStuckAt(list, 'paired', 'active');
    expect(hintText(list)).toMatch(/QR code/);
    expect(summary(list)).toBe('Pair with the bike to start.');
  });

  it('searching without Wi-Fi points at the dash Wi-Fi', () => {
    const list = buildChecklist(
      input({ phoneIp: null, snapshot: snap({ state: 'searching' }), logs: ['10:04:58 Wi-Fi join not available: no entitlement'] }),
    );
    const step = expectStuckAt(list, 'wifi', 'active');
    expect(step.detail).toMatch(/no address/);
    expect(hintText(list)).toMatch(/Settings > Wi-Fi/);
    expect(hintText(list)).toMatch(/cannot join Wi-Fi by itself/);
  });

  it('flags another network as a failure while connecting', () => {
    const list = buildChecklist(input({ phoneIp: '10.0.0.5', snapshot: snap({ state: 'searching' }) }));
    const step = expectStuckAt(list, 'wifi', 'failed');
    expect(step.detail).toContain('10.0.0.5');
    expect(summary(list)).toMatch(/another Wi-Fi/);
  });

  it('names the network kind once on the dash Wi-Fi', () => {
    const hotspot = buildChecklist(input({ snapshot: snap({ state: 'probing' }) }));
    expect(hotspot.steps[1]).toMatchObject({ status: 'done' });
    expect(hotspot.steps[1].detail).toMatch(/hotspot.*192\.168\.0\.12/);
    const direct = buildChecklist(input({ phoneIp: '192.168.49.20', snapshot: snap({ state: 'probing' }) }));
    expect(direct.steps[1].detail).toMatch(/Wi-Fi Direct/);
  });

  it('probe refused via log line blames the CFMOTO app or the dash screen', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'probing' }),
        logs: ['10:04:50 probe 192.168.0.1 #1: Error: Connection refused', '10:04:55 probe rejected by 192.168.0.1'],
      }),
    );
    const step = expectStuckAt(list, 'probe', 'failed');
    expect(step.detail).toMatch(/said no/);
    expect(hintText(list)).toMatch(/CFMOTO app/);
    expect(hintText(list)).toMatch(/phone connection screen/);
  });

  it('probe connection refused error uses the same hint', () => {
    const list = buildChecklist(
      input({ snapshot: snap({ state: 'probing' }), logs: ['10:04:50 probe 192.168.0.1 #2: Error: ECONNREFUSED'] }),
    );
    expectStuckAt(list, 'probe', 'failed');
    expect(hintText(list)).toMatch(/CFMOTO app/);
  });

  it('probe accepted, waiting for the callback', () => {
    const list = buildChecklist(
      input({ snapshot: snap({ state: 'waitingForDash' }), logs: ['10:04:59 probe accepted by 192.168.0.1'] }),
    );
    expectStuckAt(list, 'callback', 'active');
    expect(statuses(list).probe).toBe('done');
    expect(hintText(list)).toMatch(/VPN/);
    expect(hintText(list)).toMatch(/Local Network/);
  });

  it('dash never called back is a failure with the VPN hint', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'probing' }),
        logs: ['10:04:40 probe accepted by 192.168.0.1', '10:04:50 dash did not dial back'],
      }),
    );
    expectStuckAt(list, 'callback', 'failed');
    expect(hintText(list)).toMatch(/VPN/);
    expect(summary(list)).toBe('The dash never called back.');
  });

  it('handshaking before CLIENT_INFO waits for the dash details', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'handshaking' }),
        logs: ['10:04:59 probe accepted by 192.168.0.1', '10:04:59 dash connected :10922'],
      }),
    );
    expectStuckAt(list, 'identity', 'active');
    expect(statuses(list).callback).toBe('done');
  });

  it('handshaking after CLIENT_INFO shows the dash version and waits for the serial check', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'handshaking', dash: DASH }),
        logs: ['10:04:59 dash connected :10922', '10:04:59 ctrl <- CLIENT_INFO (420)'],
      }),
    );
    expectStuckAt(list, 'serial', 'active');
    expect(list.steps.find((s) => s.id === 'identity')?.detail).toBe('Dash software 3.2.1.');
  });

  it('negotiated without pulls points at the gauges screen', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'negotiated', dash: DASH, capture: CAPTURE }),
        logs: [
          '10:04:50 dash connected :10922',
          '10:04:50 ctrl <- CLIENT_INFO (420)',
          '10:04:51 ctrl <- CHECK_SN (60)',
          '10:04:51 dash connected :10921',
          '10:04:52 dash asked for 800x384@30',
        ],
      }),
    );
    expectStuckAt(list, 'pulls', 'active');
    expect(statuses(list).serial).toBe('done');
    expect(list.steps.find((s) => s.id === 'picture')?.detail).toMatch(/^800x384 at 30 fps/);
    expect(hintText(list)).toMatch(/gauges/);
  });

  it('serial check is skipped when the dash goes straight to the picture', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'negotiated', dash: DASH, capture: CAPTURE }),
        logs: ['10:04:50 dash connected :10922', '10:04:52 dash asked for 800x384@30'],
      }),
    );
    expect(statuses(list).serial).toBe('skipped');
    expectStuckAt(list, 'pulls', 'active');
  });

  it('streaming: every step is done', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'streaming', dash: DASH, capture: CAPTURE, framesSent: 1240 }),
        logs: ['10:04:50 dash connected :10922', '10:04:51 ctrl <- CHECK_SN (60)', '10:04:53 dash connected :10920'],
      }),
    );
    expect(list.stuck).toBeNull();
    expect(list.steps.every((s) => s.status === 'done')).toBe(true);
    expect(list.steps.find((s) => s.id === 'frames')?.detail).toMatch(/1,240 frames sent/);
    expect(summary(list)).toBe('The picture is on the dash.');
  });

  it('streaming with drops reports the dropped count', () => {
    const list = buildChecklist(
      input({
        mirroring: true,
        snapshot: snap({ state: 'streaming', dash: DASH, capture: CAPTURE, framesSent: 500, framesDropped: 12 }),
        logs: ['10:04:50 dash connected :10922', '10:04:51 ctrl <- CHECK_SN (60)'],
      }),
    );
    expect(list.stuck).toBeNull();
    const frames = list.steps.find((s) => s.id === 'frames');
    expect(frames?.detail).toMatch(/500 frames sent, 12 dropped \(phone screen\)/);
    expect(summary(list)).toMatch(/12 frames dropped/);
  });

  it('a lastError fails the stuck step and shows the error', () => {
    const list = buildChecklist(
      input({ snapshot: snap({ state: 'searching', lastError: 'Error: startServers failed: address in use' }) }),
    );
    const step = expectStuckAt(list, 'probe', 'failed');
    expect(step.detail).toMatch(/Last try failed: Error: startServers failed/);
  });

  it('a key error on start says to restart the app', () => {
    const list = buildChecklist(input({ snapshot: snap({ state: 'idle', lastError: 'RSA key: Error: no keychain' }) }));
    expectStuckAt(list, 'probe', 'failed');
    expect(hintText(list)).toMatch(/open it again/);
  });

  it('connect then drop every ~8 s suggests the other dash generation', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'probing', dash: DASH }),
        logs: [
          '10:04:30 probe accepted by 192.168.0.1',
          '10:04:30 dash connected :10922',
          '10:04:30 ctrl <- CLIENT_INFO (420)',
          '10:04:38 closed :10922',
          '10:04:38 dash disconnected',
          '10:04:44 probe accepted by 192.168.0.1',
          '10:04:44 dash connected :10922',
          '10:04:44 ctrl <- CLIENT_INFO (420)',
          '10:04:52 closed :10922',
          '10:04:52 dash disconnected',
          '10:04:58 probe accepted by 192.168.0.1',
        ],
      }),
    );
    const step = expectStuckAt(list, 'serial', 'failed');
    expect(step.detail).toMatch(/dropped the link after about 8 s \(2 times\)/);
    expect(hintText(list)).toMatch(/Dash generation/);
    expect(summary(list)).toMatch(/keeps dropping/);
  });

  it('ignores old drops', () => {
    const list = buildChecklist(
      input({
        snapshot: snap({ state: 'probing' }),
        logs: [
          '09:30:00 dash connected :10922',
          '09:30:08 dash disconnected',
          '09:30:20 dash connected :10922',
          '09:30:28 dash disconnected',
        ],
      }),
    );
    expectStuckAt(list, 'probe', 'active');
  });
});
