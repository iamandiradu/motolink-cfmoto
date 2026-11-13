/**
 * Ride log: Record / Stop, lifetime stats, service reminders, the saved rides
 * and GPX export. Tapping a ride opens its detail (map, full summary) in place;
 * Back returns to the list. No route of its own, so it mounts anywhere.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '../i18n';
import { formatDuration } from '../metrics/trip';
import { Body, Card, Row, Screen, colors } from '../ui/kit';
import { formatDistance, formatSpeed, rideDate, rideName } from './format';
import type { RideSummary } from './recorder';
import { RideDetail } from './RideDetail';
import { ServiceCard } from './ServiceCard';
import { useRides } from './session';
import { StatsCard } from './StatsCard';

export interface RidesScreenProps {
  /** Show miles and mph. The screen does not read settings itself so it stays free of app-state. */
  imperial?: boolean;
}

/** Re-renders once a second while recording, so the clock runs between GPS fixes. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function RidesScreen({ imperial = false }: RidesScreenProps) {
  const t = useT();
  const { recording, rides, loaded, start, stop, remove, exportGpx } = useRides();
  const now = useNow(recording !== null);
  const [stopping, setStopping] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const closeDetail = useCallback(() => setSelectedId(null), []);

  const distance = (m: number) => formatDistance(m, imperial);
  const speed = (kmh: number) => formatSpeed(kmh, imperial);

  const onStop = async () => {
    setStopping(true);
    try {
      const result = await stop();
      if (!result.saved && result.reason === 'no-track') {
        Alert.alert(t('rides.nothingSavedTitle'), t('rides.nothingSavedBody'));
      } else if (result.saved && result.evicted > 0) {
        Alert.alert(t('rides.savedTitle'), t('rides.savedBody'));
      }
    } catch {
      Alert.alert(t('rides.saveFailedTitle'), t('rides.saveFailedBody'));
    } finally {
      setStopping(false);
    }
  };

  const onExport = async (ride: RideSummary) => {
    setExporting(ride.id);
    try {
      await exportGpx(ride.id);
    } catch {
      Alert.alert(t('rides.exportFailedTitle'), t('rides.exportFailedBody'));
    } finally {
      setExporting(null);
    }
  };

  const onDelete = (ride: RideSummary) => {
    Alert.alert(t('rides.deleteTitle'), t('rides.deleteBody', { name: rideName(ride.startedAt) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          remove(ride.id)
            .then(() => setSelectedId((id) => (id === ride.id ? null : id)))
            .catch(() => Alert.alert(t('rides.deleteFailedTitle'), t('rides.deleteFailedBody')));
        },
      },
    ]);
  };

  const elapsed = recording ? (now - recording.startedAt) / 1000 : 0;
  const selected = selectedId ? rides.find((r) => r.id === selectedId) : undefined;

  if (selected) {
    return (
      <Screen>
        <RideDetail
          ride={selected}
          imperial={imperial}
          exporting={exporting === selected.id}
          onBack={closeDetail}
          onExport={() => void onExport(selected)}
          onDelete={() => onDelete(selected)}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Card title={recording ? (recording.paused ? t('rides.recordingPaused') : t('rides.recording')) : t('rides.newRide')}>
        {recording ? (
          <View
            style={styles.live}
            accessible
            accessibilityLabel={t(recording.paused ? 'rides.liveA11yPaused' : 'rides.liveA11y', {
              distance: distance(recording.distanceM),
              moving: formatDuration(recording.movingSeconds),
              total: formatDuration(elapsed),
            })}>
            <View style={styles.liveItem}>
              <Text style={styles.liveValue}>{distance(recording.distanceM)}</Text>
              <Text style={styles.liveLabel}>{t('rides.distance')}</Text>
            </View>
            <View style={styles.liveItem}>
              <Text style={styles.liveValue}>{formatDuration(recording.movingSeconds)}</Text>
              <Text style={styles.liveLabel}>{t('rides.ridingTime')}</Text>
            </View>
          </View>
        ) : (
          <Body dim>{t('rides.recordBody')}</Body>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recording ? t('rides.stopA11y') : t('rides.startA11y')}
          accessibilityState={{ disabled: stopping, busy: stopping }}
          disabled={stopping}
          onPress={recording ? onStop : () => start()}
          style={({ pressed }) => [
            styles.record,
            { backgroundColor: recording ? colors.danger : colors.accent },
            (pressed || stopping) && { opacity: 0.6 },
          ]}>
          <Text style={styles.recordLabel}>{recording ? t('rides.stop') : t('rides.record')}</Text>
        </Pressable>
        {recording ? <Body dim>{t('rides.totalTime', { time: formatDuration(elapsed) })}</Body> : null}
        {recording?.paused ? (
          <View style={styles.paused} accessibilityLiveRegion="polite">
            <Text style={styles.pausedText}>{t('rides.pausedAtStop')}</Text>
            <Body dim>{t('rides.pausedBody')}</Body>
          </View>
        ) : null}
        {recording ? <Body dim>{t('rides.keepRunning')}</Body> : null}
      </Card>

      <StatsCard rides={rides} imperial={imperial} />
      <ServiceCard imperial={imperial} />

      {loaded && rides.length === 0 ? (
        <Card title={t('rides.savedRides')}>
          <Body dim>{t('rides.noRides')}</Body>
        </Card>
      ) : null}

      {rides.map((ride) => (
        <Card key={ride.id} title={rideDate(ride.startedAt)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('rides.openA11y', {
              name: rideName(ride.startedAt),
              distance: distance(ride.distanceM),
              time: formatDuration(ride.movingSeconds),
            })}
            accessibilityHint={t('rides.openHint')}
            onPress={() => setSelectedId(ride.id)}
            style={({ pressed }) => [styles.open, pressed && { opacity: 0.6 }]}>
            <Row label={t('rides.distance')} value={distance(ride.distanceM)} />
            <Row label={t('rides.ridingTime')} value={formatDuration(ride.movingSeconds)} />
            <Row label={t('rides.topSpeed')} value={speed(ride.maxSpeedKmh)} />
            <Text style={styles.openLabel}>{t('rides.mapAndDetails')}</Text>
          </Pressable>
          <View style={styles.actions}>
            <Action
              label={exporting === ride.id ? t('rides.exporting') : t('rides.exportGpx')}
              a11y={t('rides.exportA11y', { name: rideName(ride.startedAt) })}
              disabled={exporting !== null}
              onPress={() => void onExport(ride)}
            />
            <Action
              label={t('common.delete')}
              a11y={t('rides.deleteA11y', { name: rideName(ride.startedAt) })}
              danger
              onPress={() => onDelete(ride)}
            />
          </View>
        </Card>
      ))}
    </Screen>
  );
}

/**
 * Same look as the kit's plain/danger Button, but with an accessible label
 * naming the ride: a list of identical "Delete" buttons is useless to VoiceOver.
 */
function Action(props: { label: string; a11y: string; onPress: () => void; danger?: boolean; disabled?: boolean }) {
  const tint = props.danger ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11y}
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.action,
        { borderColor: props.danger ? colors.danger : colors.line },
        (pressed || props.disabled) && { opacity: 0.5 },
      ]}>
      <Text style={[styles.actionLabel, { color: tint }]}>{props.label}</Text>
    </Pressable>
  );
}

export default RidesScreen;

const styles = StyleSheet.create({
  live: { flexDirection: 'row', gap: 12 },
  liveItem: { flex: 1, alignItems: 'center' },
  liveValue: { color: colors.text, fontSize: 32, fontWeight: '700', fontVariant: ['tabular-nums'] },
  liveLabel: { color: colors.dim, fontSize: 14 },
  paused: { borderWidth: 1, borderColor: colors.warn, borderRadius: 12, padding: 12, gap: 4 },
  pausedText: { color: colors.warn, fontSize: 17, fontWeight: '800' },
  open: { minHeight: 44, gap: 2 },
  openLabel: { color: colors.accent, fontSize: 15, fontWeight: '700', paddingVertical: 6 },
  record: { minHeight: 72, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  recordLabel: { color: colors.onAccent, fontSize: 22, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 10 },
  action: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  actionLabel: { fontSize: 16, fontWeight: '700' },
});
