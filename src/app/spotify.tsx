import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { REDIRECT_URI } from '../spotify/api';
import { handleRedirect } from '../spotify/session';

/**
 * Landing route for motolink://spotify, where Spotify sends the rider after
 * sign-in. It hands the answer to the Spotify session and returns to Settings.
 */
export default function SpotifyRedirect() {
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string }>();

  useEffect(() => {
    const query = Object.entries(params)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`)
      .join('&');
    void handleRedirect(`${REDIRECT_URI}?${query}`);
  }, [params]);

  return <Redirect href="/settings" />;
}
