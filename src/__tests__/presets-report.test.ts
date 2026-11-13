import { ReportInput, buildReport, redactSsid, redactText } from '../diagnostics/report';
import { buildStrip, sameStrip } from '../mirror/strip';
import {
  DEFAULT_MIRROR_VIEW,
  defaultPresets,
  isDefaultView,
  normalisePresets,
  normaliseView,
  toNativeView,
  updatePreset,
} from '../mirror/presets';

describe('mirror presets', () => {
  it('starts every app at the default picture', () => {
    const presets = defaultPresets();
    expect(Object.keys(presets)).toEqual(['general', 'appleMaps', 'googleMaps', 'waze']);
    expect(isDefaultView(presets.waze)).toBe(true);
  });

  it('changes one app without touching the others', () => {
    const presets = updatePreset(defaultPresets(), 'waze', { trimTop: 6, zoom: 120 });
    expect(presets.waze).toMatchObject({ trimTop: 6, zoom: 120 });
    expect(presets.googleMaps).toEqual(DEFAULT_MIRROR_VIEW);
  });

  it('clamps stored values and drops junk', () => {
    expect(normaliseView({ zoom: 900, trimTop: -5, trimLeft: 'x', fit: 'sideways' })).toEqual({
      ...DEFAULT_MIRROR_VIEW,
      zoom: 250,
    });
    expect(normalisePresets('garbage')).toEqual(defaultPresets());
  });

  it('carries an adjustment saved by an older version into the general preset', () => {
    const presets = normalisePresets(undefined, { zoom: 130, trimTop: 4 });
    expect(presets.general).toMatchObject({ zoom: 130, trimTop: 4 });
    // A stored general preset wins over the legacy value.
    expect(normalisePresets({ general: { zoom: 110 } }, { zoom: 130 }).general.zoom).toBe(110);
  });

  it('converts to the units the native side takes', () => {
    expect(toNativeView({ ...DEFAULT_MIRROR_VIEW, zoom: 125, trimTop: 6, fit: 'fit' })).toEqual({
      zoom: 1250,
      trimTop: 60,
      trimBottom: 0,
      trimLeft: 0,
      trimRight: 0,
      fit: 2,
    });
  });
});

describe('split-view strip', () => {
  const base = {
    edge: 'bottom' as const,
    speedKmh: 72.4,
    tripKm: 12.34,
    imperial: false,
    now: new Date(2026, 10, 13, 7, 5),
    trackTitle: null,
  };

  it('shows speed, time and trip distance', () => {
    expect(buildStrip(base)).toMatchObject({ enabled: true, edge: 'bottom', left: '72 km/h', center: '07:05', right: '12.3 km' });
  });

  it('shows the song instead of the trip when one is playing', () => {
    expect(buildStrip({ ...base, trackTitle: 'Riders on the Storm' }).right).toBe('♪ Riders on the Storm');
  });

  it('handles no GPS, miles and being switched off', () => {
    expect(buildStrip({ ...base, speedKmh: null }).left).toBe('-- km/h');
    expect(buildStrip({ ...base, imperial: true })).toMatchObject({ left: '45 mph', right: '7.7 mi' });
    expect(buildStrip({ ...base, edge: 'off' }).enabled).toBe(false);
    expect(buildStrip({ ...base, edge: 'top' }).edge).toBe('top');
  });

  it('only counts as changed when something visible changed', () => {
    const first = buildStrip(base);
    expect(sameStrip(null, first)).toBe(false);
    expect(sameStrip(first, buildStrip({ ...base, speedKmh: 72.1 }))).toBe(true);
    expect(sameStrip(first, buildStrip({ ...base, speedKmh: 80 }))).toBe(false);
  });
});

describe('diagnostic report', () => {
  const input: ReportInput = {
    appVersion: '0.1.0',
    system: 'iOS 27.2',
    now: new Date('2026-11-13T17:00:00Z'),
    bike: { ssid: 'CFMOTO-f46457', password: '59a9cddc94', modelId: '37416', action: 9 },
    link: {
      state: 'streaming',
      lastError: null,
      framesSent: 1200,
      framesDropped: 3,
      capture: { deviceWidth: 800, deviceHeight: 386, width: 800, height: 384, fps: 30 },
      dash: {
        name: 'CFMOTO-f46457',
        sdkVersion: '0.9.29.1',
        supportScreenTouch: false,
        raw: {
          sdkVersion: '0.9.29.1',
          HUID: 'DSXXZMHNFV3DEXEBB3PZ2',
          HUName: 'CFMOTO-f46457',
          btPin: '0000',
          socketTimeoutPeriodWifi: 9,
          supportScreenTouch: false,
        },
      },
    },
    settings: { buttonMode: 'volume', identityOs: 'Android', supportFunction: 0, bitrateKbps: 1500 },
    mirroring: true,
    lastButton: 'Up, press',
    logs: [
      '17:00:01 probe accepted by 192.168.0.1',
      '17:00:02 joined CFMOTO-f46457 with 59a9cddc94',
      '17:00:03 dash mac 6C:09:4A:0F:6C:F8 sn DSXXZMHNFV3DEXEBB3PZ2',
    ],
  };

  it('keeps what helps diagnosis', () => {
    const report = buildReport(input);
    expect(report).toContain('Dash asked for: 800x386 at 30 fps');
    expect(report).toContain('sdkVersion: 0.9.29.1');
    expect(report).toContain('Model id: 37416');
    expect(report).toContain('probe accepted by 192.168.0.1');
    expect(report).toContain('Wi-Fi: CFMOTO-******');
  });

  it('never contains the password, the unit name, the MAC, the dash id or the pin', () => {
    const report = buildReport(input);
    for (const secret of ['59a9cddc94', 'f46457', '6C:09:4A:0F:6C:F8', 'DSXXZMHNFV3DEXEBB3PZ2', '0000']) {
      expect(report).not.toContain(secret);
    }
  });

  it('works before pairing and before the dash answers', () => {
    const report = buildReport({ ...input, bike: null, link: { ...input.link, dash: null, capture: null } });
    expect(report).toContain('Not paired');
    expect(report).toContain('No reply from the dash yet');
  });

  it('redacts network names and ids in free text', () => {
    expect(redactSsid('DIRECT-CF-CFMOTO-805120')).toBe('DIRECT-CF-CFMOTO-******');
    expect(redactText('ssid DIRECT-CF-CFMOTO-805120 up', [])).toBe('ssid DIRECT-CF-CFMOTO-****** up');
    expect(redactText('pwd=hunter22 ok', ['hunter22'])).toBe('pwd=[removed] ok');
  });
});
