/**
 * Hands a ride's GPX to another app (Files, Mail, Strava, Komoot...).
 *
 * Preferred path: write a real .gpx file to the cache and open the system
 * share sheet on it, so receiving apps see a file with the right type. If the
 * file route is unavailable (no sharing module, write fails), fall back to
 * sharing the GPX as text so the rider still gets the track out.
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';

import { gpxFileName, toGpx } from './gpx';
import type { Ride } from './recorder';

export type ShareResult = 'file' | 'text';

export async function shareRideGpx(ride: Ride): Promise<ShareResult> {
  const gpx = toGpx(ride);
  const name = gpxFileName(ride);

  let uri: string | null = null;
  try {
    if (await Sharing.isAvailableAsync()) {
      // Cache, not documents: the file is only a hand-off and the OS may clear it.
      const file = new File(Paths.cache, name);
      if (file.exists) file.delete();
      file.create();
      // In SDK 58 write() returns a Promise (it was sync in earlier SDKs); await
      // it so the share sheet never opens on a half-written file.
      await file.write(gpx);
      uri = file.uri;
    }
  } catch {
    uri = null;
  }

  if (uri) {
    // Errors from the share sheet itself (rider cancelled, target failed) are
    // not a reason to also pop the text share; let them reach the caller.
    await Sharing.shareAsync(uri, {
      mimeType: 'application/gpx+xml',
      UTI: 'com.topografix.gpx',
      dialogTitle: 'Export ride',
    });
    return 'file';
  }

  await Share.share({ title: name, message: gpx });
  return 'text';
}
