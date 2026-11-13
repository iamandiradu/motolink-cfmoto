import Constants from 'expo-constants';
import { Platform, Share } from 'react-native';

import { getState } from '../app-state/store';
import { GESTURE_LABELS } from '../buttons/gestures';
import { formatCrashes, loadCrashes } from './crashLog';
import { buildReport } from './report';
import { formatTrace, linkTrace } from './trace';

/** Opens the share sheet with a report that is safe to post in public. */
export async function shareReport(): Promise<void> {
  const state = getState();
  const report = buildReport({
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    system: `${Platform.OS} ${String(Platform.Version)}`,
    now: new Date(),
    bike: state.bike,
    link: state.link,
    settings: state.settings,
    mirroring: state.mirroring,
    lastButton: state.lastButton?.gesture ? GESTURE_LABELS[state.lastButton.gesture] : null,
    logs: state.logs,
  });
  // Wi-Fi name and password are stripped from every part.
  const secrets = state.bike ? [state.bike.password, state.bike.ssid] : [];
  const crashes = await loadCrashes().catch(() => []);
  const message = [
    report,
    '',
    'Link trace',
    formatTrace(linkTrace.snapshot(), secrets),
    '',
    'Errors',
    formatCrashes(crashes, secrets),
  ].join('\n');
  await Share.share({ title: 'MotoLink report', message });
}
