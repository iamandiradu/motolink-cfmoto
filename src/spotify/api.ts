/**
 * Spotify Web API, the parts the dash Music page needs. Pure request building
 * and response parsing; `fetch` is passed in so this runs under Jest.
 *
 * iOS lets no app see what another app is playing, so the page cannot read the
 * Spotify app on the phone. It asks Spotify's servers instead. That needs the
 * rider's own Spotify developer client ID, mobile data, and (for the control
 * endpoints) a Premium account.
 */

import { t } from '../i18n';

export const REDIRECT_URI = 'motolink://spotify';
export const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing'];

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch. */
  expiresAt: number;
}

export interface Playback {
  isPlaying: boolean;
  title: string;
  artist: string;
  album: string;
  /** Cover art URL, null for local files and some podcasts. */
  imageUrl: string | null;
  progressMs: number;
  durationMs: number;
  /** Where Spotify is playing, e.g. "iPhone". */
  device: string | null;
  /** When this reading was taken, to extrapolate progress between polls. */
  fetchedAt: number;
}

export type MusicCommand = 'play' | 'pause' | 'next' | 'previous';

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/** base64 to the URL-safe alphabet PKCE requires. */
export function base64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildAuthUrl(clientId: string, codeChallenge: string, state: string): string {
  return `${ACCOUNTS}/authorize?${form({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
    scope: SCOPES.join(' '),
  })}`;
}

export type RedirectResult = { code: string } | { error: string } | null;

/** Reads the URL Spotify sends the rider back to. null when it is not ours. */
export function parseRedirect(url: string, expectedState: string): RedirectResult {
  if (!url.startsWith(REDIRECT_URI)) return null;
  const query = url.split('?')[1]?.split('#')[0] ?? '';
  const params: Record<string, string> = {};
  for (const part of query.split('&')) {
    const [key, value = ''] = part.split('=');
    if (key) params[key] = decodeURIComponent(value);
  }
  if (params.error) return { error: params.error };
  if (params.state !== expectedState) return { error: 'state mismatch' };
  return params.code ? { code: params.code } : { error: 'no code' };
}

function readTokens(json: unknown, now: number, previousRefresh?: string): Tokens {
  const data = (json ?? {}) as Record<string, unknown>;
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  // A refresh reply may omit the refresh token; the old one then stays valid.
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : (previousRefresh ?? '');
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  if (!accessToken || !refreshToken) throw new SpotifyError(t('spotify.noToken'), 0);
  // Renew a minute early so a request never goes out with a token about to lapse.
  return { accessToken, refreshToken, expiresAt: now + (expiresIn - 60) * 1000 };
}

async function tokenRequest(fetch: Fetch, body: Record<string, string>, now: number, previousRefresh?: string) {
  const response = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(body),
  });
  if (!response.ok) throw new SpotifyError(t('spotify.signInFailed', { status: response.status }), response.status);
  return readTokens(await response.json(), now, previousRefresh);
}

export function exchangeCode(fetch: Fetch, clientId: string, code: string, codeVerifier: string, now = Date.now()) {
  return tokenRequest(
    fetch,
    { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: codeVerifier },
    now,
  );
}

export function refreshTokens(fetch: Fetch, clientId: string, refreshToken: string, now = Date.now()) {
  return tokenRequest(fetch, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, now, refreshToken);
}

export function parsePlayback(json: unknown, now: number): Playback | null {
  const data = (json ?? {}) as Record<string, any>;
  const item = data.item;
  if (!item || typeof item !== 'object') return null;
  // Tracks carry artists and an album; podcast episodes carry a show instead.
  const artists: string[] = Array.isArray(item.artists) ? item.artists.map((a: any) => a?.name).filter(Boolean) : [];
  const images: any[] = item.album?.images ?? item.images ?? item.show?.images ?? [];
  // Images come largest first; the middle one (about 300 px) is plenty for the dash.
  const image = images[1] ?? images[0];
  return {
    isPlaying: data.is_playing === true,
    title: typeof item.name === 'string' ? item.name : '',
    artist: artists.join(', ') || (item.show?.name ?? ''),
    album: item.album?.name ?? '',
    imageUrl: typeof image?.url === 'string' ? image.url : null,
    progressMs: typeof data.progress_ms === 'number' ? data.progress_ms : 0,
    durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : 0,
    device: typeof data.device?.name === 'string' ? data.device.name : null,
    fetchedAt: now,
  };
}

/** Current playback, or null when nothing is playing anywhere. */
export async function getPlayback(fetch: Fetch, accessToken: string, now = Date.now()): Promise<Playback | null> {
  const response = await fetch(`${API}/me/player?additional_types=episode`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new SpotifyError(t('spotify.playbackFailed', { status: response.status }), response.status);
  return parsePlayback(await response.json(), now);
}

const COMMANDS: Record<MusicCommand, { method: string; path: string }> = {
  play: { method: 'PUT', path: '/me/player/play' },
  pause: { method: 'PUT', path: '/me/player/pause' },
  next: { method: 'POST', path: '/me/player/next' },
  previous: { method: 'POST', path: '/me/player/previous' },
};

/** Why a command was refused, in words for the rider (in the current app language). */
export function explainFailure(status: number): string {
  if (status === 401) return t('spotify.expired');
  if (status === 403) return t('spotify.refused');
  if (status === 404) return t('spotify.nothingPlaying');
  if (status === 429) return t('spotify.rateLimited');
  return t('spotify.error', { status });
}

export async function sendCommand(fetch: Fetch, accessToken: string, command: MusicCommand): Promise<void> {
  const { method, path } = COMMANDS[command];
  const response = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new SpotifyError(explainFailure(response.status), response.status);
}

/** Position now, assuming the track kept playing since the last reading. */
export function currentProgressMs(playback: Playback, now: number): number {
  if (!playback.isPlaying) return playback.progressMs;
  return Math.min(playback.durationMs, playback.progressMs + (now - playback.fetchedAt));
}

export function formatTrackTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
