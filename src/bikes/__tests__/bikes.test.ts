import { DashInfo } from '../../protocol/control';
import { parsePairingQr } from '../../protocol/qr';
import { SessionSnapshot } from '../../protocol/session';
import { LearnedBike, emptyLearned, learnFromSnapshot, mergeLearned, normaliseLearned, workingIdentity } from '../learned';
import { sessionOptionsFor } from '../link';
import { BikeEvidence, evidenceFrom, matchProfile } from '../match';
import { BIKE_PROFILES, allProfiles, defaultLayoutFor, findProfile, sdkMatches } from '../profiles';
import { exportBikeReport, exportProfileJson, parseProfileJson, redactSsid } from '../share';
import { DEFAULT_LAYOUT } from '../../buttons/mapping';

const profile = (id: string) => findProfile(id)!;

function dash(patch: Partial<DashInfo> = {}, raw: Record<string, unknown> = {}): DashInfo {
  return {
    huid: 'HUID-SECRET-0042',
    name: 'CFMOTO-f46457',
    sdkVersion: '0.9.29.1',
    channel: null,
    supportScreenTouch: false,
    socketTimeoutSec: null,
    raw: { supportScreenTouch: false, ...raw },
    ...patch,
  };
}

function snapshot(patch: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { state: 'idle', dash: null, capture: null, framesSent: 0, framesDropped: 0, lastError: null, ...patch };
}

const capture = (w: number, h: number) => ({ deviceWidth: w, deviceHeight: h, width: w & 0xfff0, height: h & 0xfff0, fps: 30 });

describe('profiles', () => {
  it('has the required bikes and a generic fallback', () => {
    const ids = BIKE_PROFILES.map((p) => p.id);
    for (const id of ['450mt', '450sr', '675sr-r', '800mt', '800nk-advanced', '1000mt-x', 'cl-c450', 'generic']) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(profile('450mt').verified).toBe(false);
    expect(profile('450mt').modelIds).toEqual([]);
    expect(profile('450mt').panel).toBeNull();
  });

  it('marks guesses only on fields that hold a value', () => {
    for (const p of BIKE_PROFILES) {
      for (const field of p.guessed) {
        const value = p[field];
        expect(value === null || value === undefined || (Array.isArray(value) && value.length === 0)).toBe(false);
      }
    }
  });

  it('compares sdk versions segment by segment', () => {
    expect(sdkMatches('0.9.29', '0.9.29.1')).toBe(true);
    expect(sdkMatches('1.1', '1.1.7')).toBe(true);
    expect(sdkMatches('0.9.2', '0.9.29.1')).toBe(false);
    expect(sdkMatches('1.1', '1')).toBe(false);
  });

  it('keeps the default layout for the 450 MT', () => {
    expect(defaultLayoutFor(profile('450mt'))).toEqual(DEFAULT_LAYOUT);
    expect(defaultLayoutFor({ ...profile('generic'), layout: { upPress: 'zoomIn' } }).upPress).toBe('zoomIn');
  });
});

describe('matchProfile', () => {
  it.each([
    ['37416', '675sr-r'],
    ['66660742', '450sr'],
    ['66660736', 'cl-c450'],
    ['66660703', '800nk-us'],
    ['66660721', '800nk-us'],
    ['66660732', '800nk-us'],
  ])('model id %s alone is likely the %s', (modelId, id) => {
    const m = matchProfile({ modelId });
    expect(m.profile.id).toBe(id);
    expect(m.confidence).toBe('likely');
    expect(m.reasons[0]).toContain(modelId);
  });

  it('becomes certain once the dash confirms the model id', () => {
    const m = matchProfile({ modelId: '37416', sdkVersion: '0.9.29.1', touch: false, panel: { width: 800, height: 386 } });
    expect(m.profile.id).toBe('675sr-r');
    expect(m.confidence).toBe('certain');
  });

  it('treats 37426 as ambiguous until size or touch decide', () => {
    const qrOnly = matchProfile({ modelId: '37426' });
    expect(['1000mt-x', '800mt', '800nk-advanced']).toContain(qrOnly.profile.id);
    expect(qrOnly.confidence).toBe('guess');
    expect(qrOnly.reasons[0]).toContain('shared');

    const mt = matchProfile({ modelId: '37426', touch: true, sdkVersion: '1.1.3', panel: { width: 1280, height: 576 } });
    expect(mt.profile.id).toBe('800mt');
    expect(mt.confidence).toBe('certain');

    const nk = matchProfile({ modelId: '37426', touch: true, panel: { width: 720, height: 712 } });
    expect(nk.profile.id).toBe('800nk-advanced');

    // No touch rules out the two touch dashes even before the panel size arrives.
    const x = matchProfile({ modelId: '37426', touch: false });
    expect(x.profile.id).toBe('1000mt-x');
    expect(matchProfile({ modelId: '37426', wifi: 'p2p', panel: { width: 800, height: 951 } }).profile.id).toBe('1000mt-x');
  });

  it('picks the 450 MT for an unknown id on an access point, and grows more sure with an 800-wide panel', () => {
    const qr = matchProfile({ modelId: '66660799', wifi: 'ap' });
    expect(qr.profile.id).toBe('450mt');
    expect(qr.confidence).toBe('guess');
    const later = matchProfile({ modelId: '66660799', wifi: 'ap', touch: false, panel: { width: 800, height: 480 } });
    expect(later.profile.id).toBe('450mt');
    expect(later.confidence).toBe('likely');
  });

  it('lets the Wi-Fi kind overrule a 450SR model id', () => {
    const m = matchProfile({ modelId: '66660742', wifi: 'ap' });
    expect(m.profile.id).toBe('450mt');
    expect(m.reasons.some((r) => r.startsWith('not the 450SR'))).toBe(true);
  });

  it('falls back to generic for a bike that fits nothing', () => {
    const ev: BikeEvidence = { modelId: '12345', wifi: 'p2p', touch: true, panel: { width: 1024, height: 600 } };
    const m = matchProfile(ev);
    expect(m.profile.id).toBe('generic');
    expect(m.confidence).toBe('guess');
    expect(matchProfile({}).profile.id).toBe('generic');
  });

  it('always honours the rider choice', () => {
    const m = matchProfile({ modelId: '37416' }, { manualId: '450mt' });
    expect(m.profile.id).toBe('450mt');
    expect(m.confidence).toBe('certain');
    // An unknown stored id falls back to automatic.
    expect(matchProfile({ modelId: '37416' }, { manualId: 'gone' }).profile.id).toBe('675sr-r');
  });

  it('builds evidence from the QR, the live session and what was learned', () => {
    const creds = parsePairingQr('http://x/_sdk?modelid=37426&ssid=DIRECT-ab-CFMOTO&pwd=secret&action=8')!;
    const learned: LearnedBike = { ...emptyLearned(creds.ssid, 1), capture: capture(800, 951), sdkVersion: '1.1.0' };
    const ev = evidenceFrom({ credentials: creds, snapshot: snapshot({ dash: dash({ sdkVersion: '1.1.4' }, { supportScreenTouch: undefined }) }), learned });
    expect(ev).toEqual({ modelId: '37426', wifi: 'p2p', sdkVersion: '1.1.4', touch: null, panel: { width: 800, height: 951 } });
    expect(matchProfile(ev).profile.id).toBe('1000mt-x');
  });

  it('matches imported profiles', () => {
    const custom = { ...profile('generic'), id: 'custom-7', name: 'CFMOTO 450 MT (shared)', modelIds: ['7'], verified: true };
    expect(matchProfile({ modelId: '7' }, { profiles: allProfiles([custom]) }).profile.id).toBe('custom-7');
  });
});

describe('learned bike', () => {
  const ssid = 'CFMOTO-f46457';
  const identity = { phoneOs: 'Android', supportFunction: 128 };

  it('learns nothing before the dash talks', () => {
    expect(learnFromSnapshot(null, { ssid, snapshot: snapshot({ state: 'searching' }), identity, now: 1 })).toBeNull();
  });

  it('records what the dash reported and which identity streamed', () => {
    const a = learnFromSnapshot(null, { ssid, modelId: '66660799', snapshot: snapshot({ state: 'handshaking', dash: dash() }), identity, now: 1000 })!;
    expect(a).toMatchObject({ ssid, modelId: '66660799', sdkVersion: '0.9.29.1', huName: 'CFMOTO-f46457', supportScreenTouch: false, firstSeen: 1000 });
    expect(a.identities).toEqual([{ phoneOs: 'Android', supportFunction: 128, streamed: false, lastTried: 1000 }]);
    expect(workingIdentity(a)).toBeNull();

    const b = learnFromSnapshot(a, { ssid, snapshot: snapshot({ state: 'streaming', dash: dash(), capture: capture(800, 480), framesSent: 3 }), identity, now: 2000 })!;
    expect(b.capture).toEqual(capture(800, 480));
    expect(b.firstSeen).toBe(1000);
    expect(b.lastSeen).toBe(2000);
    expect(workingIdentity(b)).toMatchObject(identity);

    // Same data again shortly after: same object, so the caller skips the write.
    const c = learnFromSnapshot(b, { ssid, snapshot: snapshot({ state: 'streaming', dash: dash(), capture: capture(800, 480), framesSent: 90 }), identity, now: 5000 });
    expect(c).toBe(b);

    // A later failure with the same identity does not undo "it worked".
    const d = learnFromSnapshot(b, { ssid, snapshot: snapshot({ state: 'handshaking', dash: dash() }), identity, now: 10 * 60 * 1000 + 5000 })!;
    expect(workingIdentity(d)).toMatchObject(identity);
  });

  it('treats a missing touch field as unknown', () => {
    const r = learnFromSnapshot(null, { ssid, snapshot: snapshot({ dash: dash({}, { supportScreenTouch: undefined }) }), identity, now: 1 })!;
    expect(r.supportScreenTouch).toBeNull();
  });

  it('merges two records, newer wins, nothing replaced by null', () => {
    const old: LearnedBike = { ...emptyLearned(ssid, 100), lastSeen: 200, modelId: '1', capture: capture(800, 480), identities: [{ ...identity, streamed: true, lastTried: 150 }] };
    const fresh: LearnedBike = { ...emptyLearned(ssid, 300), lastSeen: 400, modelId: '2', sdkVersion: '0.9.29.1', identities: [{ ...identity, streamed: false, lastTried: 390 }] };
    const merged = mergeLearned(fresh, old);
    expect(merged).toMatchObject({ modelId: '2', sdkVersion: '0.9.29.1', capture: capture(800, 480), firstSeen: 100, lastSeen: 400 });
    expect(merged.identities).toEqual([{ ...identity, streamed: true, lastTried: 390 }]);
    expect(() => mergeLearned(old, { ...fresh, ssid: 'other' })).toThrow();
  });

  it('reads stored records defensively', () => {
    expect(normaliseLearned(null)).toBeNull();
    expect(normaliseLearned({ ssid: 3 })).toBeNull();
    const r = normaliseLearned({ ssid, capture: { deviceWidth: 'x' }, identities: [{ phoneOs: 'iOS', supportFunction: 0 }, 'junk'] })!;
    expect(r.capture).toBeNull();
    expect(r.identities).toHaveLength(1);
  });
});

describe('sessionOptionsFor', () => {
  it('prefers an identity that worked on this dash', () => {
    const learned: LearnedBike = { ...emptyLearned('S', 1), identities: [{ phoneOs: 'iOS', supportFunction: 0, streamed: true, lastTried: 1 }] };
    expect(sessionOptionsFor(profile('450mt'), learned)).toMatchObject({ source: 'learned', identity: { phoneOs: 'iOS', phoneType: 'iOS', supportFunction: 0 } });
  });

  it('uses the profile otherwise, and nothing for the generic profile', () => {
    expect(sessionOptionsFor(profile('675sr-r'), null)).toMatchObject({ source: 'profile', identity: { supportFunction: 0 } });
    expect(sessionOptionsFor(profile('450mt'), null).reason).toContain('guess');
    expect(sessionOptionsFor(profile('generic'), null)).toMatchObject({ source: 'none', identity: {} });
  });
});

describe('export', () => {
  const qr =
    'http://www.carbit.com.cn/downsdk/657/658/_sdk?modelid=66660799&sn=peTz&action=1&ssid=CFMOTO-f46457' +
    '&pwd=hunter2pass&auth=wpa2-psk&mac=6C:09:4A:0F:6C:F8&name=CFMOTO-f46457';
  const creds = parsePairingQr(qr)!;

  it('redacts the SSID suffix, password, MAC, HUID and serial', () => {
    const learned = learnFromSnapshot(null, {
      ssid: creds.ssid,
      modelId: creds.modelId,
      snapshot: snapshot({ state: 'streaming', dash: dash({ name: 'CFMOTO-f46457 6c094a0f6cf8 SN123456789' }), capture: capture(800, 480), framesSent: 1 }),
      identity: { phoneOs: 'Android', supportFunction: 128 },
      now: 1,
    })!;
    const json = exportBikeReport({
      learned,
      credentials: creds,
      huid: 'HUID-SECRET-0042',
      match: matchProfile(evidenceFrom({ credentials: creds, learned })),
      note: 'my bike peTz, wifi hunter2pass, mac 6C:09:4A:0F:6C:F8',
    });
    for (const secret of ['f46457', 'hunter2pass', '6C:09', '6c094a', 'HUID-SECRET', 'peTz', '123456789', qr]) {
      expect(json.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    const report = JSON.parse(json);
    expect(report).toMatchObject({
      format: 'motolink-bike-report',
      modelId: '66660799',
      ssidPrefix: 'CFMOTO-***',
      wifi: 'ap',
      sdkVersion: '0.9.29.1',
      panel: { width: 800, height: 480 },
      detected: { profile: '450mt' },
    });
    expect(report.huName).toMatch(/^CFMOTO-\*\*\*/);
  });

  it('masks SSIDs without a separator too', () => {
    expect(redactSsid('MotoPlay1234')).toBe('MotoPlay***');
    expect(redactSsid('DIRECT-ab-CFMOTO')).toBe('DIRECT-***');
  });

  it('round-trips a report into an importable profile', () => {
    const learned = { ...emptyLearned(creds.ssid, 1), modelId: '66660799', sdkVersion: '0.9.29.1', capture: capture(800, 480), supportScreenTouch: false, chosenProfileId: '450mt',
      identities: [{ phoneOs: 'Android', supportFunction: 128, streamed: true, lastTried: 1 }] };
    const result = parseProfileJson(exportBikeReport({ learned, credentials: creds }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toMatchObject({
      id: 'custom-66660799',
      name: 'CFMOTO 450 MT (shared)',
      modelIds: ['66660799'],
      sdkPrefixes: ['0.9.29'],
      panel: { width: 800, height: 480 },
      wifi: 'ap',
      touch: false,
      supportFunction: 128,
      verified: true,
    });
    const again = parseProfileJson(exportProfileJson(result.profile));
    expect(again).toEqual({ ok: true, profile: result.profile });
  });
});

describe('import validation', () => {
  const good = {
    id: 'my-bike',
    name: 'CFMOTO 450 MT',
    modelIds: ['66660799'],
    sdkPrefixes: ['0.9.29'],
    panel: { width: 800, height: 480 },
    wifi: 'ap',
    touch: false,
    supportFunction: 128,
    layout: { upPress: 'focusPrevious' },
    verified: true,
    guessed: [],
    notes: 'ok',
  };

  it('accepts a well-formed profile', () => {
    const r = parseProfileJson(JSON.stringify(good));
    expect(r.ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ['empty', ''],
    ['not json', '{nope'],
    ['an array', '[]'],
    ['a number', '42'],
    ['other format', JSON.stringify({ ...good, format: 'something-else' })],
    ['missing id', JSON.stringify({ ...good, id: undefined })],
    ['bad id', JSON.stringify({ ...good, id: '../../etc' })],
    ['built-in id', JSON.stringify({ ...good, id: '450mt' })],
    ['missing name', JSON.stringify({ ...good, name: '' })],
    ['name too long', JSON.stringify({ ...good, name: 'x'.repeat(200) })],
    ['control characters', JSON.stringify({ ...good, name: 'a\u0000b' })],
    ['model id not digits', JSON.stringify({ ...good, modelIds: ['abc'] })],
    ['model ids not a list', JSON.stringify({ ...good, modelIds: '37416' })],
    ['bad sdk prefix', JSON.stringify({ ...good, sdkPrefixes: ['1.x'] })],
    ['huge panel', JSON.stringify({ ...good, panel: { width: 99999, height: 480 } })],
    ['fractional panel', JSON.stringify({ ...good, panel: { width: 800.5, height: 480 } })],
    ['bad wifi', JSON.stringify({ ...good, wifi: 'bluetooth' })],
    ['touch as text', JSON.stringify({ ...good, touch: 'yes' })],
    ['negative supportFunction', JSON.stringify({ ...good, supportFunction: -1 })],
    ['unknown layout button', JSON.stringify({ ...good, layout: { horn: 'select' } })],
    ['unknown layout action', JSON.stringify({ ...good, layout: { upPress: 'launchMissiles' } })],
    ['unknown guessed field', JSON.stringify({ ...good, guessed: ['price'] })],
    ['too long overall', JSON.stringify({ ...good, notes: 'x'.repeat(20_000) })],
    ['report with junk model id', JSON.stringify({ format: 'motolink-bike-report', modelId: 'DROP TABLE' })],
  ])('rejects %s', (_label, text) => {
    const r = parseProfileJson(text as string);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
