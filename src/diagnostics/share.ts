import Constants from 'expo-constants';
import { Platform, Share } from 'react-native';

import { getState } from '../app-state/store';
import { GESTURE_LABELS } from '../buttons/gestures';
import { buildReport } from './report';

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
  await Share.share({ title: 'MotoLink report', message: report });
}
