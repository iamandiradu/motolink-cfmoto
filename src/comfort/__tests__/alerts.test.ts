import { EMPTY_METRICS, Metrics } from '../../metrics/trip';
import {
  AlertId,
  AlertInput,
  AlertTracker,
  ComfortAlert,
  DEFAULT_COMFORT_SETTINGS,
  evaluateAlerts,
  normalizeComfortSettings,
  pickStripAlert,
} from '../alerts';

const T0 = Date.parse('2026-06-21T10:00:00Z');

function input(over: Partial<Omit<AlertInput, 'metrics'>> & { metrics?: Partial<Metrics> } = {}): AlertInput {
  const { metrics, settings, ...rest } = over;
  return {
    metrics: { ...EMPTY_METRICS, speedKmh: 50, accuracyM: 5, ...metrics },
    batteryLevel: 0.8,
    charging: false,
    linkConnected: true,
    linkExpected: true,
    mirroring: true,
    mirroringExpected: true,
    settings: { ...DEFAULT_COMFORT_SETTINGS, ...settings },
    now: T0,
    ...rest,
  };
}

const ids = (alerts: ComfortAlert[]) => alerts.map((a) => a.id);
const find = (alerts: ComfortAlert[], id: AlertId) => alerts.find((a) => a.id === id);

describe('evaluateAlerts', () => {
  it('is quiet when all is well', () => {
    expect(evaluateAlerts(input())).toEqual([]);
  });

  describe('speed', () => {
    const at = (speedKmh: number | null, previous: AlertId[] = []) =>
      ids(evaluateAlerts(input({ metrics: { speedKmh }, settings: { ...DEFAULT_COMFORT_SETTINGS, speedWarningKmh: 90 }, previous })));

    it('turns on at limit + 3', () => {
      expect(at(92)).not.toContain('speed');
      expect(at(93)).toContain('speed');
    });

    it('stays on until limit - 2 (hysteresis)', () => {
      expect(at(90, ['speed'])).toContain('speed');
      expect(at(88.5, ['speed'])).toContain('speed');
      expect(at(88, ['speed'])).not.toContain('speed');
    });

    it('is off without a limit or a speed', () => {
      expect(ids(evaluateAlerts(input({ metrics: { speedKmh: 200 } })))).not.toContain('speed');
      expect(at(null)).not.toContain('speed');
    });

    it('uses mph when imperial', () => {
      const a = evaluateAlerts(
        input({ metrics: { speedKmh: 120 }, imperial: true, settings: { ...DEFAULT_COMFORT_SETTINGS, speedWarningKmh: 113 } }),
      );
      expect(find(a, 'speed')).toMatchObject({ short: 'Over 70 mph', dashFlash: true });
      expect(find(a, 'speed')!.spoken).toContain('miles per hour');
    });
  });

  describe('fuel', () => {
    const fuel = (kmSinceRefuel: number, fuelRangeKm: number | null = 250) =>
      find(evaluateAlerts(input({ settings: { ...DEFAULT_COMFORT_SETTINGS, fuelRangeKm, kmSinceRefuel } })), 'fuel');

    it('warns at 80 % and is urgent at 100 %', () => {
      expect(fuel(199)).toBeUndefined();
      expect(fuel(200)).toMatchObject({ severity: 'warn', short: 'Fuel 50 km left' });
      expect(fuel(250)).toMatchObject({ severity: 'urgent', short: 'Refuel now', dashFlash: true });
      expect(fuel(400)).toMatchObject({ severity: 'urgent' });
    });

    it('is off without a range and clears after a refuel', () => {
      expect(fuel(400, null)).toBeUndefined();
      expect(fuel(0)).toBeUndefined();
    });
  });

  describe('battery', () => {
    const bat = (batteryLevel: number | null, charging = false, previous: AlertId[] = []) =>
      find(evaluateAlerts(input({ batteryLevel, charging, previous })), 'battery');

    it('warns at the threshold when not charging, urgent at 10 %', () => {
      expect(bat(0.21)).toBeUndefined();
      expect(bat(0.2)).toMatchObject({ severity: 'warn', short: 'Phone battery 20%', dashFlash: false });
      expect(bat(0.1)).toMatchObject({ severity: 'urgent', dashFlash: true });
      expect(bat(0.05, true)).toBeUndefined();
      expect(bat(null)).toBeUndefined();
    });

    it('clears a little above the threshold so it does not flicker', () => {
      expect(bat(0.22, false, ['battery'])).toBeDefined();
      expect(bat(0.23, false, ['battery'])).toBeUndefined();
    });

    it('is off when the rider turned it off', () => {
      expect(
        find(evaluateAlerts(input({ batteryLevel: 0.05, settings: { ...DEFAULT_COMFORT_SETTINGS, lowBatteryPercent: null } })), 'battery'),
      ).toBeUndefined();
    });
  });

  it('warns when the phone is hot', () => {
    expect(find(evaluateAlerts(input({ thermal: 'fair' })), 'thermal')).toBeUndefined();
    expect(find(evaluateAlerts(input({ thermal: 'serious' })), 'thermal')).toMatchObject({ severity: 'warn' });
    expect(find(evaluateAlerts(input({ thermal: 'critical' })), 'thermal')).toMatchObject({ severity: 'urgent' });
  });

  describe('GPS', () => {
    it('is lost when there is no fix while riding', () => {
      expect(ids(evaluateAlerts(input({ metrics: { accuracyM: null }, riding: true })))).toContain('gps');
      expect(ids(evaluateAlerts(input({ metrics: { accuracyM: null }, riding: false })))).not.toContain('gps');
    });

    it('uses the age of the last fix when given', () => {
      expect(ids(evaluateAlerts(input({ lastFixAt: T0 - 5_000, riding: true })))).not.toContain('gps');
      expect(ids(evaluateAlerts(input({ lastFixAt: T0 - 11_000, riding: true })))).toContain('gps');
      expect(ids(evaluateAlerts(input({ lastFixAt: null, riding: true })))).toContain('gps');
    });
  });

  describe('link and mirroring', () => {
    it('raises link lost only while riding and when the link should be up', () => {
      expect(ids(evaluateAlerts(input({ linkConnected: false })))).toContain('link');
      expect(ids(evaluateAlerts(input({ linkConnected: false, riding: false })))).not.toContain('link');
      expect(ids(evaluateAlerts(input({ linkConnected: false, linkExpected: false })))).not.toContain('link');
    });

    it('raises mirroring stopped only when it stopped on its own and the link is up', () => {
      expect(ids(evaluateAlerts(input({ mirroring: false })))).toEqual(['mirroring']);
      expect(ids(evaluateAlerts(input({ mirroring: false, mirroringExpected: false })))).toEqual([]);
      expect(ids(evaluateAlerts(input({ mirroring: false, linkConnected: false })))).toEqual(['link']);
    });
  });

  it('keeps strip texts at 18 characters or less and never sends the rider to the phone', () => {
    const all = [
      ...evaluateAlerts(
        input({
          metrics: { speedKmh: 250, accuracyM: null },
          batteryLevel: 0.05,
          thermal: 'critical',
          mirroring: false,
          settings: { ...DEFAULT_COMFORT_SETTINGS, speedWarningKmh: 200, fuelRangeKm: 600, kmSinceRefuel: 500, lowBatteryPercent: 99 },
        }),
      ),
      ...evaluateAlerts(input({ linkConnected: false, batteryLevel: 1, charging: false, settings: { ...DEFAULT_COMFORT_SETTINGS, lowBatteryPercent: 99 } })),
      ...evaluateAlerts(input({ settings: { ...DEFAULT_COMFORT_SETTINGS, fuelRangeKm: 600, kmSinceRefuel: 600 } })),
    ];
    expect(new Set(ids(all))).toEqual(new Set(['speed', 'fuel', 'battery', 'thermal', 'gps', 'mirroring', 'link']));
    for (const a of all) {
      expect(a.short.length).toBeLessThanOrEqual(18);
      expect(a.spoken).toMatch(/[.!]$/);
      expect(`${a.short} ${a.spoken}`).not.toMatch(/look|check|open the|tap|unlock/i);
    }
  });
});

describe('pickStripAlert', () => {
  const alert = (id: AlertId, severity: ComfortAlert['severity']): ComfortAlert => ({
    id,
    severity,
    short: id,
    spoken: `${id}.`,
    dashFlash: false,
  });

  it('returns null with no alerts', () => {
    expect(pickStripAlert([])).toBeNull();
  });

  it('always shows the speed warning first', () => {
    expect(pickStripAlert([alert('fuel', 'urgent'), alert('speed', 'warn'), alert('link', 'urgent')])!.id).toBe('speed');
  });

  it('then the most severe, then by priority', () => {
    expect(pickStripAlert([alert('gps', 'warn'), alert('battery', 'urgent')])!.id).toBe('battery');
    expect(pickStripAlert([alert('battery', 'warn'), alert('gps', 'warn'), alert('fuel', 'warn')])!.id).toBe('fuel');
    expect(pickStripAlert([alert('fuel', 'urgent'), alert('link', 'urgent')])!.id).toBe('link');
    expect(pickStripAlert([alert('thermal', 'info'), alert('battery', 'info')])!.id).toBe('battery');
  });
});

describe('AlertTracker', () => {
  const speedOn = { ...DEFAULT_COMFORT_SETTINGS, speedWarningKmh: 90 };

  it('raises once, clears once, and speaks within the cooldown only once', () => {
    const tracker = new AlertTracker({ voiceCooldownMs: 5 * 60_000 });
    const tick = (speedKmh: number, t: number) => tracker.update(input({ metrics: { speedKmh }, settings: speedOn, now: T0 + t }));

    expect(tick(95, 0)).toEqual([expect.objectContaining({ type: 'raised', speak: true })]);
    expect(tick(96, 1_000)).toEqual([]);
    expect(tracker.active.map((a) => a.id)).toEqual(['speed']);
    expect(tick(80, 2_000)).toEqual([expect.objectContaining({ type: 'cleared', speak: false })]);
    expect(tracker.active).toEqual([]);

    // Over again a minute later: shown, but not spoken again.
    expect(tick(95, 60_000)).toEqual([expect.objectContaining({ type: 'raised', speak: false })]);
    tick(80, 61_000);
    // After the cooldown it is spoken again.
    expect(tick(95, 6 * 60_000)).toEqual([expect.objectContaining({ type: 'raised', speak: true })]);
  });

  it('keeps hysteresis across updates', () => {
    const tracker = new AlertTracker();
    const tick = (speedKmh: number, t: number) => tracker.update(input({ metrics: { speedKmh }, settings: speedOn, now: T0 + t }));
    tick(93, 0);
    expect(tick(89, 1_000)).toEqual([]);
    expect(tick(91, 2_000)).toEqual([]);
    expect(tick(88, 3_000)).toEqual([expect.objectContaining({ type: 'cleared' })]);
    expect(tick(92, 4_000)).toEqual([]);
  });

  it('never speaks with voice off', () => {
    const tracker = new AlertTracker();
    const events = tracker.update(input({ metrics: { speedKmh: 120 }, settings: { ...speedOn, voice: false } }));
    expect(events).toEqual([expect.objectContaining({ type: 'raised', speak: false })]);
  });

  it('speaks an escalation even inside the cooldown', () => {
    const tracker = new AlertTracker();
    const fuel = (kmSinceRefuel: number, t: number) =>
      tracker.update(input({ settings: { ...DEFAULT_COMFORT_SETTINGS, fuelRangeKm: 100, kmSinceRefuel }, now: T0 + t }));
    expect(fuel(85, 0)).toEqual([expect.objectContaining({ type: 'raised', escalated: false, speak: true })]);
    expect(fuel(90, 10_000)).toEqual([]);
    expect(fuel(100, 20_000)).toEqual([
      expect.objectContaining({ type: 'raised', escalated: true, speak: true, alert: expect.objectContaining({ severity: 'urgent' }) }),
    ]);
  });

  it('waits out short link drop-outs', () => {
    const tracker = new AlertTracker();
    const link = (linkConnected: boolean, t: number) => tracker.update(input({ linkConnected, now: T0 + t }));
    expect(link(false, 0)).toEqual([]);
    expect(link(true, 2_000)).toEqual([]);
    expect(link(false, 3_000)).toEqual([]);
    expect(link(false, 8_000)).toEqual([expect.objectContaining({ type: 'raised', alert: expect.objectContaining({ id: 'link' }) })]);
    expect(link(true, 9_000)).toEqual([expect.objectContaining({ type: 'cleared' })]);
  });

  it('remembers the ride when GPS is lost and speed is unknown', () => {
    const tracker = new AlertTracker({ raiseDelayMs: { gps: 0 } });
    tracker.update(input({ metrics: { speedKmh: 60 }, now: T0 }));
    const events = tracker.update(input({ metrics: { speedKmh: null, accuracyM: null }, now: T0 + 30_000 }));
    expect(events).toEqual([expect.objectContaining({ type: 'raised', alert: expect.objectContaining({ id: 'gps' }) })]);
    // Parked for longer than the ride hold: no longer riding, so it clears.
    const later = tracker.update(input({ metrics: { speedKmh: null, accuracyM: null }, now: T0 + 5 * 60_000 }));
    expect(later).toEqual([expect.objectContaining({ type: 'cleared' })]);
  });

  it('orders active alerts with the strip pick first', () => {
    const tracker = new AlertTracker();
    tracker.update(
      input({
        metrics: { speedKmh: 100 },
        batteryLevel: 0.05,
        settings: { ...DEFAULT_COMFORT_SETTINGS, speedWarningKmh: 90 },
      }),
    );
    expect(tracker.active.map((a) => a.id)).toEqual(['speed', 'battery']);
  });
});

describe('normalizeComfortSettings', () => {
  it('fills defaults and drops bad values', () => {
    expect(normalizeComfortSettings(null)).toEqual(DEFAULT_COMFORT_SETTINGS);
    expect(normalizeComfortSettings({ speedWarningKmh: -5, lowBatteryPercent: null, gloveMode: 'x', voice: false })).toEqual({
      ...DEFAULT_COMFORT_SETTINGS,
      lowBatteryPercent: null,
      voice: false,
    });
  });
});
