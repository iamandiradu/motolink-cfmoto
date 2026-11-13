/**
 * Spotify connection: sign-in, token upkeep, polling and commands.
 * The refresh token lives in the iOS Keychain.
 */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';

import { appendLog, getState, saveSettings, setState } from '../app-state/store';
import { base64Encode } from '../protocol/bytes';
import {
  Fetch,
  MusicCommand,
  SpotifyError,
  Tokens,
  base64Url,
  buildAuthUrl,
  exchangeCode,
  explainFailure,
  getPlayback,
  parseRedirect,
  refreshTokens,
  sendCommand,
} from './api';

const TOKEN_KEY = 'spotify.tokens';
/** Often enough for the progress bar and track changes, well inside Spotify's rate limits. */
const POLL_MS = 3000;

const http: Fetch = (url, init) => fetch(url, init);

let tokens: Tokens | null = null;
let pending: { verifier: string; state: string } | null = null;
let poller: ReturnType<typeof setInterval> | null = null;
let polling = false;

function setSpotify(patch: Partial<ReturnType<typeof getState>['spotify']>): void {
  setState({ spotify: { ...getState().spotify, ...patch } });
}

async function saveTokens(next: Tokens | null): Promise<void> {
  tokens = next;
  if (next) await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(next));
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

function randomString(bytes: number): string {
  return base64Url(base64Encode(Crypto.getRandomBytes(bytes)));
}

/** Opens Spotify's consent page. The answer comes back through handleRedirect. */
export async function connectSpotify(): Promise<void> {
  const clientId = getState().settings.spotifyClientId.trim();
  if (!clientId) {
    setSpotify({ error: 'Enter your Spotify client ID first.' });
    return;
  }
  const verifier = randomString(48);
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  pending = { verifier, state: randomString(12) };
  setSpotify({ error: null });
  await Linking.openURL(buildAuthUrl(clientId, base64Url(digest), pending.state));
}

/** Handles motolink://spotify?code=... Returns true when the URL was a Spotify answer. */
export async function handleRedirect(url: string): Promise<boolean> {
  if (!pending) return false;
  const result = parseRedirect(url, pending.state);
  if (!result) return false;
  const { verifier } = pending;
  pending = null;
  if ('error' in result) {
    setSpotify({ error: `Spotify sign-in was not completed (${result.error}).` });
    return true;
  }
  try {
    await saveTokens(await exchangeCode(http, getState().settings.spotifyClientId.trim(), result.code, verifier));
    setSpotify({ connected: true, error: null });
    appendLog('Spotify connected');
    void refreshPlayback();
  } catch (error) {
    setSpotify({ error: String(error instanceof Error ? error.message : error) });
  }
  return true;
}

export async function disconnectSpotify(): Promise<void> {
  await saveTokens(null).catch(() => undefined);
  setSpotify({ connected: false, playback: null, error: null });
}

export function setSpotifyClientId(clientId: string): void {
  saveSettings({ spotifyClientId: clientId.trim() });
}

async function accessToken(): Promise<string | null> {
  if (!tokens) return null;
  if (Date.now() < tokens.expiresAt) return tokens.accessToken;
  try {
    await saveTokens(await refreshTokens(http, getState().settings.spotifyClientId.trim(), tokens.refreshToken));
    return tokens?.accessToken ?? null;
  } catch (error) {
    // 400 means the refresh token was revoked: the rider must sign in again.
    if (error instanceof SpotifyError && error.status === 400) {
      await disconnectSpotify();
      setSpotify({ error: explainFailure(401) });
    }
    return null;
  }
}

export async function refreshPlayback(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const token = await accessToken();
    if (!token) return;
    setSpotify({ playback: await getPlayback(http, token), error: null });
  } catch (error) {
    // Offline is normal on the bike's Wi-Fi until iOS falls back to mobile data; keep the last reading.
    if (error instanceof SpotifyError) setSpotify({ error: explainFailure(error.status) });
  } finally {
    polling = false;
  }
}

export async function musicCommand(command: MusicCommand | 'toggle'): Promise<void> {
  const token = await accessToken();
  if (!token) {
    setSpotify({ error: 'Connect Spotify in Settings.' });
    return;
  }
  const playback = getState().spotify.playback;
  const resolved: MusicCommand = command === 'toggle' ? (playback?.isPlaying ? 'pause' : 'play') : command;
  // Show the change at once; the next poll confirms it.
  if (playback && (resolved === 'play' || resolved === 'pause')) {
    setSpotify({ playback: { ...playback, isPlaying: resolved === 'play', fetchedAt: Date.now() } });
  }
  try {
    await sendCommand(http, token, resolved);
    setSpotify({ error: null });
  } catch (error) {
    setSpotify({ error: String(error instanceof Error ? error.message : error) });
  }
  setTimeout(() => void refreshPlayback(), 600);
}

/** Polls only while the Music page is the one on the dash. */
export function setMusicPageVisible(visible: boolean): void {
  if (visible && !poller) {
    void refreshPlayback();
    poller = setInterval(() => void refreshPlayback(), POLL_MS);
  } else if (!visible && poller) {
    clearInterval(poller);
    poller = null;
  }
}

/** Called once at start: restores a saved sign-in and listens for the redirect. */
export async function bootstrapSpotify(): Promise<void> {
  try {
    const stored = await SecureStore.getItemAsync(TOKEN_KEY);
    const parsed = stored ? (JSON.parse(stored) as Tokens) : null;
    if (parsed?.refreshToken) {
      tokens = parsed;
      setSpotify({ connected: true });
    }
  } catch {
    // A missing or unreadable entry just means "not connected".
  }
  Linking.addEventListener('url', ({ url }) => void handleRedirect(url));
}
