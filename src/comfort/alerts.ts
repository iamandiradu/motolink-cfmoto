/**
 * Riding comfort alerts: speed over the rider's own limit, fuel reminder,
 * phone battery and heat, GPS, dash link and mirroring.
 *
 * evaluateAlerts is pure: one snapshot in, the alerts active now out.
 * AlertTracker turns successive snapshots into raised / cleared events, waits
 * out short drop-outs and keeps voice from repeating itself.
 *
 * Texts are for a rider with the phone in a pocket: they never ask the rider
 * to look at the phone.
 */

import type { Metrics } from '../metrics/trip';
import type { GloveMode } from './glove';

export interface ComfortSettings {
  /** Warn above this speed, km/h. null: off. */
  speedWarningKmh: number | null;
  /** Distance a full tank lasts, km. null: no fuel reminder. */
  fuelRangeKm: number | null;
  /** Ridden since the rider last said they refuelled, km. */
  kmSinceRefuel: number;
  /** Warn when the phone battery is at or below this, percent. null: off. */
  lowBatteryPercent: number | null;
  /** Speak alerts through the phone audio (helmet headset). */
  voice: boolean;
  /** Pick the dash theme by daylight. */
  autoTheme: boolean;
  dayTheme: string;
  nightTheme: string;
  gloveMode: GloveMode;
}

export const DEFAULT_COMFORT_SETTINGS: ComfortSettings = {
  speedWarningKmh: null,
  fuelRangeKm: null,
  kmSinceRefuel: 0,
  lowBatteryPercent: 20,
  voice: true,
  autoTheme: false,
  dayTheme: 'day',
  nightTheme: 'aurora',
  gloveMode: 'whenConnected',
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Fills gaps and drops bad values in settings read back from storage. */
export function normalizeComfortSettings(raw: unknown): ComfortSettings {
  const d = DEFAULT_COMFORT_SETTINGS;
  if (typeof raw !== 'object' || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  const positiveOrNull = (v: unknown, fallback: number | null) =>
    v === null ? null : num(v) && v > 0 ? v : fallback;
  return {
    speedWarningKmh: positiveOrNull(r.speedWarningKmh, d.speedWarningKmh),
    fuelRangeKm: positiveOrNull(r.fuelRangeKm, d.fuelRangeKm),
    kmSinceRefuel: num(r.kmSinceRefuel) && r.kmSinceRefuel >= 0 ? r.kmSinceRefuel : d.kmSinceRefuel,
    lowBatteryPercent:
      r.lowBatteryPercent === null
        ? null
        : num(r.lowBatteryPercent) && r.lowBatteryPercent > 0 && r.lowBatteryPercent < 100
          ? r.lowBatteryPercent
          : d.lowBatteryPercent,
    voice: typeof r.voice === 'boolean' ? r.voice : d.voice,
    autoTheme: typeof r.autoTheme === 'boolean' ? r.autoTheme : d.autoTheme,
    dayTheme: typeof r.dayTheme === 'string' ? r.dayTheme : d.dayTheme,
    nightTheme: typeof r.nightTheme === 'string' ? r.nightTheme : d.nightTheme,
    gloveMode: r.gloveMode === 'off' || r.gloveMode === 'on' || r.gloveMode === 'whenConnected' ? r.gloveMode : d.gloveMode,
  };
}

export type AlertId = 'speed' | 'fuel' | 'battery' | 'thermal' | 'gps' | 'link' | 'mirroring';
export type AlertSeverity = 'info' | 'warn' | 'urgent';

export interface ComfortAlert {
  id: AlertId;
  severity: AlertSeverity;
  /** At most 18 characters, for the dash strip. */
  short: string;
  /** A full sentence for voice. */
  spoken: string;
  /** Flash the dash strip to catch the eye. */
  dashFlash: boolean;
}

export interface AlertInput {
  metrics: Metrics;
  /** Phone battery 0..1, null when unknown. */
  batteryLevel: number | null;
  charging: boolean;
  /** Device thermal state if known: 'nominal' | 'fair' | 'serious' | 'critical'. */
  thermal?: string | null;
  /** The dash link is up now. */
  linkConnected: boolean;
  /**
   * The link should be up: it was connected this ride and the rider did not
   * disconnect it. Without this no link alert is raised.
   */
  linkExpected: boolean;
  /** The phone screen is being mirrored now. */
  mirroring: boolean;
  /** Mirroring should be running: the rider started it and did not stop it. */
  mirroringExpected: boolean;
  /** ms since epoch of the last GPS fix. Omitted: no fix means accuracyM is null. */
  lastFixAt?: number | null;
  /** A ride is under way. Defaults to moving at walking pace or faster. AlertTracker remembers it. */
  riding?: boolean;
  /** Speak and show mph and miles. */
  imperial?: boolean;
  settings: ComfortSettings;
  now: Date | number;
  /** Alert ids active in the last evaluation, for hysteresis. AlertTracker passes them. */
  previous?: readonly AlertId[];
}

/** Speed alert: on at limit + 3 km/h, off again below limit - 2. */
export const SPEED_ON_MARGIN_KMH = 3;
export const SPEED_OFF_MARGIN_KMH = 2;
/** Battery alert clears this many points above the threshold (or when charging). */
export const BATTERY_CLEAR_MARGIN = 2;
export const BATTERY_URGENT_PERCENT = 10;
/** No fix for this long counts as GPS lost. */
export const GPS_STALE_MS = 10_000;
/** Moving at least this fast counts as riding. */
export const RIDING_SPEED_KMH = 8;

const KM_TO_MI = 0.621371;

const ms = (t: Date | number) => (typeof t === 'number' ? t : t.getTime());

export function evaluateAlerts(input: AlertInput): ComfortAlert[] {
  const { metrics, settings } = input;
  const now = ms(input.now);
  const was = new Set(input.previous ?? []);
  const imperial = input.imperial ?? false;
  const factor = imperial ? KM_TO_MI : 1;
  const speedUnit = imperial ? 'mph' : 'km/h';
  const speedWords = imperial ? 'miles per hour' : 'kilometres per hour';
  const distUnit = imperial ? 'mi' : 'km';
  const distWords = imperial ? 'miles' : 'kilometres';
  const riding = input.riding ?? (metrics.speedKmh ?? 0) >= RIDING_SPEED_KMH;
  const alerts: ComfortAlert[] = [];

  // Speed over the rider's own limit.
  const limit = settings.speedWarningKmh;
  if (limit !== null && metrics.speedKmh !== null) {
    const threshold = was.has('speed') ? limit - SPEED_OFF_MARGIN_KMH : limit + SPEED_ON_MARGIN_KMH;
    const over = was.has('speed') ? metrics.speedKmh > threshold : metrics.speedKmh >= threshold;
    if (over) {
      const shown = Math.round(limit * factor);
      alerts.push({
        id: 'speed',
        severity: 'warn',
        short: `Over ${shown} ${speedUnit}`,
        spoken: `You are over ${shown} ${speedWords}.`,
        dashFlash: true,
      });
    }
  }

  // Fuel reminder from distance since the last refuel.
  const range = settings.fuelRangeKm;
  if (range !== null && range > 0) {
    const used = settings.kmSinceRefuel / range;
    if (used >= 1) {
      alerts.push({
        id: 'fuel',
        severity: 'urgent',
        short: 'Refuel now',
        spoken: 'Fuel reminder. You have ridden your full range. Refuel soon.',
        dashFlash: true,
      });
    } else if (used >= 0.8) {
      const left = Math.max(0, Math.round((range - settings.kmSinceRefuel) * factor));
      alerts.push({
        id: 'fuel',
        severity: 'warn',
        short: `Fuel ${left} ${distUnit} left`,
        spoken: `Fuel reminder. About ${left} ${distWords} left.`,
        dashFlash: false,
      });
    }
  }

  // Phone battery low and not charging.
  const lowAt = settings.lowBatteryPercent;
  if (lowAt !== null && input.batteryLevel !== null && !input.charging) {
    const pct = Math.round(Math.max(0, Math.min(1, input.batteryLevel)) * 100);
    const threshold = was.has('battery') ? lowAt + BATTERY_CLEAR_MARGIN : lowAt;
    if (pct <= threshold) {
      const urgent = pct <= BATTERY_URGENT_PERCENT;
      alerts.push({
        id: 'battery',
        severity: urgent ? 'urgent' : 'warn',
        short: `Phone battery ${pct}%`,
        spoken: urgent
          ? `Phone battery is at ${pct} percent. Charge it at your next stop.`
          : `Phone battery is at ${pct} percent.`,
        dashFlash: urgent,
      });
    }
  }

  // Phone too hot: iOS slows it down, mirroring may stutter.
  const thermal = (input.thermal ?? '').toLowerCase();
  if (thermal === 'serious' || thermal === 'critical') {
    const critical = thermal === 'critical';
    alerts.push({
      id: 'thermal',
      severity: critical ? 'urgent' : 'warn',
      short: 'Phone is hot',
      spoken: critical
        ? 'The phone is very hot. Mirroring may stop.'
        : 'The phone is getting hot. Mirroring may slow down.',
      dashFlash: critical,
    });
  }

  if (riding) {
    // GPS lost.
    const lost =
      input.lastFixAt === undefined
        ? metrics.accuracyM === null
        : input.lastFixAt === null || now - input.lastFixAt > GPS_STALE_MS;
    if (lost) {
      alerts.push({
        id: 'gps',
        severity: 'warn',
        short: 'GPS lost',
        spoken: 'GPS signal lost. Speed and trip are paused.',
        dashFlash: false,
      });
    }

    // Dash link dropped.
    const linkDown = input.linkExpected && !input.linkConnected;
    if (linkDown) {
      alerts.push({
        id: 'link',
        severity: 'urgent',
        short: 'Dash link lost',
        spoken: 'Dash connection lost.',
        dashFlash: false,
      });
    }

    // Mirroring stopped on its own (only while the link is up; else the link alert covers it).
    if (!linkDown && input.mirroringExpected && !input.mirroring) {
      alerts.push({
        id: 'mirroring',
        severity: 'warn',
        short: 'Mirroring stopped',
        spoken: 'Screen mirroring stopped.',
        dashFlash: true,
      });
    }
  }

  return alerts;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warn: 1, urgent: 2 };

/** Tie-break among alerts of the same severity: first wins. */
export const STRIP_PRIORITY: readonly AlertId[] = ['speed', 'link', 'mirroring', 'fuel', 'gps', 'battery', 'thermal'];

/**
 * The one alert to show on the dash strip. The speed warning always wins: it
 * is short-lived and needs action now, and a long-running alert such as fuel
 * must not hide it. Otherwise the most severe, then by STRIP_PRIORITY.
 */
export function pickStripAlert(alerts: readonly ComfortAlert[]): ComfortAlert | null {
  if (alerts.length === 0) return null;
  const speed = alerts.find((a) => a.id === 'speed');
  if (speed) return speed;
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      STRIP_PRIORITY.indexOf(a.id) - STRIP_PRIORITY.indexOf(b.id),
  )[0];
}

export interface AlertEvent {
  type: 'raised' | 'cleared';
  alert: ComfortAlert;
  /** Raised again at a higher severity (fuel warn to urgent, battery to 10 %). */
  escalated: boolean;
  /** Say alert.spoken now: voice is on and the cooldown has passed. */
  speak: boolean;
}

export interface AlertTrackerOptions {
  /** Minimum time between two spoken announcements of the same alert. Default 5 minutes. */
  voiceCooldownMs?: number | Partial<Record<AlertId, number>>;
  /** How long a condition must last before it is raised, per alert. */
  raiseDelayMs?: Partial<Record<AlertId, number>>;
  /** A ride counts as under way this long after the last moment of movement. Default 2 minutes. */
  ridingHoldMs?: number;
}

export const DEFAULT_VOICE_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_RAISE_DELAY_MS: Record<AlertId, number> = {
  speed: 0,
  fuel: 0,
  battery: 0,
  thermal: 5_000,
  gps: 5_000,
  link: 5_000,
  mirroring: 5_000,
};

export class AlertTracker {
  private readonly cooldown: (id: AlertId) => number;
  private readonly delay: (id: AlertId) => number;
  private readonly ridingHoldMs: number;
  private raw: AlertId[] = [];
  private pendingSince = new Map<AlertId, number>();
  private confirmed = new Map<AlertId, ComfortAlert>();
  private lastSpoken = new Map<AlertId, number>();
  private lastMovingAt: number | null = null;

  constructor(options: AlertTrackerOptions = {}) {
    const c = options.voiceCooldownMs;
    this.cooldown = (id) =>
      typeof c === 'number' ? c : (c?.[id] ?? DEFAULT_VOICE_COOLDOWN_MS);
    this.delay = (id) => options.raiseDelayMs?.[id] ?? DEFAULT_RAISE_DELAY_MS[id];
    this.ridingHoldMs = options.ridingHoldMs ?? 2 * 60_000;
  }

  /** The alerts raised and not yet cleared, most important first. */
  get active(): ComfortAlert[] {
    const list = [...this.confirmed.values()];
    const top = pickStripAlert(list);
    return top ? [top, ...list.filter((a) => a !== top).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])] : [];
  }

  /** Feed one snapshot; returns what changed. Call on every metrics tick or state change. */
  update(input: Omit<AlertInput, 'previous'>): AlertEvent[] {
    const now = ms(input.now);
    if ((input.metrics.speedKmh ?? 0) >= RIDING_SPEED_KMH) this.lastMovingAt = now;
    const riding =
      input.riding ?? (this.lastMovingAt !== null && now - this.lastMovingAt <= this.ridingHoldMs);

    const current = evaluateAlerts({ ...input, riding, previous: this.raw });
    this.raw = current.map((a) => a.id);
    const events: AlertEvent[] = [];

    for (const alert of current) {
      const since = this.pendingSince.get(alert.id) ?? now;
      this.pendingSince.set(alert.id, since);
      if (now - since < this.delay(alert.id)) continue;

      const before = this.confirmed.get(alert.id);
      this.confirmed.set(alert.id, alert);
      const escalated = before !== undefined && SEVERITY_RANK[alert.severity] > SEVERITY_RANK[before.severity];
      if (before !== undefined && !escalated) continue;

      const last = this.lastSpoken.get(alert.id);
      const speak = input.settings.voice && (escalated || last === undefined || now - last >= this.cooldown(alert.id));
      if (speak) this.lastSpoken.set(alert.id, now);
      events.push({ type: 'raised', alert, escalated, speak });
    }

    const ids = new Set(this.raw);
    for (const id of [...this.pendingSince.keys()]) {
      if (ids.has(id)) continue;
      this.pendingSince.delete(id);
      const gone = this.confirmed.get(id);
      if (gone) {
        this.confirmed.delete(id);
        events.push({ type: 'cleared', alert: gone, escalated: false, speak: false });
      }
    }
    return events;
  }

  /** Forget everything, e.g. at the end of a ride. Voice cooldowns are kept. */
  reset(): void {
    this.raw = [];
    this.pendingSince.clear();
    this.confirmed.clear();
    this.lastMovingAt = null;
  }
}
