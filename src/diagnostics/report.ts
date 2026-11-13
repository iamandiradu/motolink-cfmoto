/**
 * Text report the rider can share after a ride, so a connection problem can be
 * diagnosed and the bike's profile tuned. Pure: takes plain data, returns text.
 *
 * It must be safe to post in public. The Wi-Fi password, the unique part of
 * the network name, MAC addresses, the dash's unit id and serial numbers are
 * all removed. Those identify one particular motorcycle and its Wi-Fi.
 */

export interface ReportInput {
  appVersion: string;
  /** e.g. "iOS 27.2". */
  system: string;
  /** When the report was made. */
  now: Date;
  bike: { ssid: string; password: string; modelId: string | null; action: number } | null;
  link: {
    state: string;
    lastError: string | null;
    framesSent: number;
    framesDropped: number;
    capture: { deviceWidth: number; deviceHeight: number; width: number; height: number; fps: number } | null;
    dash: { name: string | null; sdkVersion: string | null; supportScreenTouch: boolean; raw: Record<string, unknown> } | null;
  };
  settings: {
    buttonMode: string;
    identityOs: string;
    supportFunction: number | string;
    bitrateKbps: number;
  };
  mirroring: boolean;
  lastButton: string | null;
  logs: readonly string[];
}

/** Dash CLIENT_INFO fields that are safe and useful. Everything else is left out. */
const SAFE_DASH_KEYS = [
  'sdkVersion',
  'version_name',
  'package_name',
  'channel',
  'flavor',
  'pxcVersion',
  'productType',
  'screenType',
  'mirrorMode',
  'socketTimeoutPeriodWifi',
  'supportScreenTouch',
  'supportHID',
  'supportFunction',
  'enableSockServerAuth',
  'dpi',
] as const;

/** "CFMOTO-f46457" -> "CFMOTO-******": keeps the family, hides the unit. */
export function redactSsid(ssid: string): string {
  const cut = ssid.lastIndexOf('-');
  if (cut < 0) return '*'.repeat(Math.min(ssid.length, 8));
  return `${ssid.slice(0, cut + 1)}${'*'.repeat(ssid.length - cut - 1)}`;
}

/** Removes secrets and unit identifiers from free text such as log lines. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('[removed]');
  }
  return (
    out
      // MAC addresses.
      .replace(/\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/g, '[mac]')
      // The unique tail of a dash network name.
      .replace(/\b((?:DIRECT-[A-Za-z]{2}-)?CFMOTO-?)[0-9A-Za-z]{4,}\b/g, '$1******')
      // Long serial-like tokens (HUID, bike serial).
      .replace(/\b[A-Z0-9]{16,}\b/g, '[id]')
  );
}

export function buildReport(input: ReportInput): string {
  const secrets = input.bike ? [input.bike.password, input.bike.ssid] : [];
  const lines: string[] = [];
  const add = (label: string, value: string | number | boolean | null) => lines.push(`${label}: ${value ?? 'unknown'}`);

  lines.push('MotoLink report');
  add('Made', input.now.toISOString());
  add('App', input.appVersion);
  add('Phone', input.system);
  lines.push('');

  lines.push('Bike');
  if (input.bike) {
    add('  Wi-Fi', redactSsid(input.bike.ssid));
    add('  Model id', input.bike.modelId);
    add('  Transport bits', input.bike.action);
  } else {
    lines.push('  Not paired');
  }
  lines.push('');

  lines.push('Link');
  add('  State', input.link.state);
  add('  Last error', input.link.lastError ? redactText(input.link.lastError, secrets) : 'none');
  add('  Mirroring', input.mirroring ? 'on' : 'off');
  add('  Frames sent / dropped', `${input.link.framesSent} / ${input.link.framesDropped}`);
  if (input.link.capture) {
    const c = input.link.capture;
    add('  Dash asked for', `${c.deviceWidth}x${c.deviceHeight} at ${c.fps} fps`);
    add('  Encoded at', `${c.width}x${c.height}`);
  } else {
    add('  Dash asked for', 'nothing yet');
  }
  lines.push('');

  lines.push('Dash');
  if (input.link.dash) {
    for (const key of SAFE_DASH_KEYS) {
      const value = input.link.dash.raw[key];
      if (value !== undefined && (typeof value !== 'object' || value === null)) {
        add(`  ${key}`, String(value));
      }
    }
  } else {
    lines.push('  No reply from the dash yet');
  }
  lines.push('');

  lines.push('Settings');
  add('  Buttons', input.settings.buttonMode);
  add('  Phone type sent', input.settings.identityOs);
  add('  Dash generation flag', input.settings.supportFunction);
  add('  Picture quality (kbps)', input.settings.bitrateKbps);
  add('  Last button', input.lastButton ?? 'none seen');
  lines.push('');

  lines.push(`Log (last ${Math.min(input.logs.length, 150)} lines)`);
  for (const line of input.logs.slice(-150)) lines.push(`  ${redactText(line, secrets)}`);

  return lines.join('\n');
}
