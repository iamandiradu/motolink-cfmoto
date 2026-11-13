import {
  Fetch,
  REDIRECT_URI,
  SpotifyError,
  base64Url,
  buildAuthUrl,
  currentProgressMs,
  exchangeCode,
  formatTrackTime,
  getPlayback,
  parsePlayback,
  parseRedirect,
  refreshTokens,
  sendCommand,
} from '../api';

function fakeFetch(status: number, body: unknown = {}) {
  const calls: { url: string; init?: Parameters<Fetch>[1] }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

describe('Spotify sign-in', () => {
  it('builds the PKCE authorize URL', () => {
    const url = buildAuthUrl('abc123', 'CHALLENGE', 'xyz');
    expect(url).toContain('https://accounts.spotify.com/authorize?');
    expect(url).toContain('client_id=abc123');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('code_challenge=CHALLENGE');
    expect(url).toContain(`redirect_uri=${encodeURIComponent(REDIRECT_URI)}`);
    expect(url).toContain('user-modify-playback-state');
    expect(url).not.toContain('client_secret');
  });

  it('makes base64 URL-safe', () => {
    expect(base64Url('a+b/c==')).toBe('a-b_c');
  });

  it('reads the redirect and checks the state', () => {
    expect(parseRedirect('motolink://spotify?code=C0DE&state=s1', 's1')).toEqual({ code: 'C0DE' });
    expect(parseRedirect('motolink://spotify?code=C0DE&state=other', 's1')).toEqual({ error: 'state mismatch' });
    expect(parseRedirect('motolink://spotify?error=access_denied&state=s1', 's1')).toEqual({ error: 'access_denied' });
    expect(parseRedirect('motolink://elsewhere?code=1', 's1')).toBeNull();
  });

  it('exchanges the code without a client secret', async () => {
    const { fetch, calls } = fakeFetch(200, { access_token: 'A', refresh_token: 'R', expires_in: 3600 });
    const tokens = await exchangeCode(fetch, 'abc123', 'C0DE', 'verifier', 1_000_000);
    expect(tokens).toEqual({ accessToken: 'A', refreshToken: 'R', expiresAt: 1_000_000 + 3540 * 1000 });
    expect(calls[0].init?.body).toContain('grant_type=authorization_code');
    expect(calls[0].init?.body).toContain('code_verifier=verifier');
    expect(calls[0].init?.body).not.toContain('secret');
  });

  it('keeps the old refresh token when a refresh reply omits it', async () => {
    const { fetch } = fakeFetch(200, { access_token: 'A2', expires_in: 3600 });
    expect((await refreshTokens(fetch, 'abc123', 'R-OLD', 0)).refreshToken).toBe('R-OLD');
  });

  it('reports a failed sign-in', async () => {
    const { fetch } = fakeFetch(400, { error: 'invalid_grant' });
    await expect(exchangeCode(fetch, 'abc123', 'bad', 'v')).rejects.toBeInstanceOf(SpotifyError);
  });
});

describe('Spotify playback', () => {
  const track = {
    is_playing: true,
    progress_ms: 61_000,
    device: { name: 'iPhone' },
    item: {
      name: 'Riders on the Storm',
      duration_ms: 434_000,
      artists: [{ name: 'The Doors' }, { name: 'Guest' }],
      album: { name: 'L.A. Woman', images: [{ url: 'big' }, { url: 'medium' }, { url: 'small' }] },
    },
  };

  it('reads a track', () => {
    expect(parsePlayback(track, 5000)).toEqual({
      isPlaying: true,
      title: 'Riders on the Storm',
      artist: 'The Doors, Guest',
      album: 'L.A. Woman',
      imageUrl: 'medium',
      progressMs: 61_000,
      durationMs: 434_000,
      device: 'iPhone',
      fetchedAt: 5000,
    });
  });

  it('reads a podcast episode', () => {
    const episode = {
      is_playing: false,
      item: { name: 'Ep 12', duration_ms: 1000, show: { name: 'Moto Talk' }, images: [{ url: 'art' }] },
    };
    expect(parsePlayback(episode, 0)).toMatchObject({
      title: 'Ep 12',
      artist: 'Moto Talk',
      imageUrl: 'art',
      isPlaying: false,
    });
  });

  it('treats 204 and an empty item as nothing playing', async () => {
    expect(await getPlayback(fakeFetch(204).fetch, 'A')).toBeNull();
    expect(parsePlayback({ is_playing: false, item: null }, 0)).toBeNull();
  });

  it('advances progress between polls only while playing, and never past the end', () => {
    const playback = parsePlayback(track, 0)!;
    expect(currentProgressMs(playback, 2000)).toBe(63_000);
    expect(currentProgressMs({ ...playback, isPlaying: false }, 2000)).toBe(61_000);
    expect(currentProgressMs(playback, 10_000_000)).toBe(434_000);
  });

  it('sends commands with the right verb and explains refusals', async () => {
    const ok = fakeFetch(204);
    await sendCommand(ok.fetch, 'A', 'next');
    await sendCommand(ok.fetch, 'A', 'pause');
    expect(ok.calls.map((c) => `${c.init?.method} ${c.url.split('/v1')[1]}`)).toEqual([
      'POST /me/player/next',
      'PUT /me/player/pause',
    ]);
    expect(ok.calls[0].init?.headers?.Authorization).toBe('Bearer A');
    await expect(sendCommand(fakeFetch(403).fetch, 'A', 'play')).rejects.toThrow(/Premium/);
    await expect(sendCommand(fakeFetch(404).fetch, 'A', 'play')).rejects.toThrow(/Nothing is playing/);
  });

  it('formats track time', () => {
    expect(formatTrackTime(61_000)).toBe('1:01');
    expect(formatTrackTime(0)).toBe('0:00');
  });
});
