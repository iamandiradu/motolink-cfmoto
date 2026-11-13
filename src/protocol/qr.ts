/**
 * Pairing QR shown by the dash on its MotoPlay screen.
 *
 *   http://www.carbit.com.cn/downsdk/657/658/_sdk?modelid=37416&sn=peTz&action=9
 *      &ssid=CFMOTO-xxxxxx&pwd=...&auth=wpa2-psk&mac=6C:09:4A:0F:6C:F8&name=CFMOTO-xxxxxx
 *
 * The Wi-Fi SSID and password are the whole pairing: the dash issues no token.
 */

export interface BikeCredentials {
  ssid: string;
  password: string;
  auth: string | null;
  mac: string | null;
  name: string | null;
  modelId: string | null;
  /** Transport bitmask: 1 AP, 2 AP+internet, 8 Wi-Fi Direct, 64 Bluetooth, 128 phone hosts hotspot. */
  action: number;
  /** Original QR text, kept so a later parser version can re-read it. */
  raw: string;
}

export const ACTION_AP = 1;
export const ACTION_AP_INTERNET = 2;
export const ACTION_P2P = 8;
export const ACTION_BLUETOOTH = 64;
export const ACTION_PHONE_HOTSPOT = 128;

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function normaliseMac(mac: string | undefined): string | null {
  if (!mac) return null;
  const digits = mac.replace(/[^0-9a-fA-F]/g, '');
  if (digits.length !== 12) return mac;
  return digits.toLowerCase().match(/.{2}/g)!.join(':');
}

export function parsePairingQr(text: string): BikeCredentials | null {
  const raw = text.trim();
  const q = raw.indexOf('?');
  if (q < 0) return null;
  const query = raw.slice(q + 1).split('#')[0];

  const params: Record<string, string> = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    params[key] = eq < 0 ? '' : decode(part.slice(eq + 1));
  }

  const ssid = (params.ssid ?? '').trim();
  const password = params.pwd ?? '';
  if (!ssid || !password) return null;

  const action = Number.parseInt(params.action ?? '0', 10);
  return {
    ssid,
    password,
    auth: params.auth || null,
    mac: normaliseMac(params.mac ?? params.bm),
    name: params.name || null,
    modelId: params.modelid || null,
    action: Number.isFinite(action) ? action : 0,
    raw,
  };
}

/** True when the dash runs a Wi-Fi Direct group; its address is then 192.168.49.1. */
export function isWifiDirect(creds: Pick<BikeCredentials, 'ssid' | 'action'>): boolean {
  const apCapable = (creds.action & (ACTION_AP | ACTION_AP_INTERNET)) !== 0;
  return creds.ssid.startsWith('DIRECT-') || ((creds.action & ACTION_P2P) !== 0 && !apCapable);
}

/** Dash address to try when the gateway cannot be read from the interface. */
export function fallbackDashAddress(creds: Pick<BikeCredentials, 'ssid' | 'action'>): string {
  return isWifiDirect(creds) ? '192.168.49.1' : '192.168.0.1';
}
