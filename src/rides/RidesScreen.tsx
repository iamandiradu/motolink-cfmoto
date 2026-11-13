/** Ride log: Record / Stop, the saved rides, GPX export. */
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDuration } from '../metrics/trip';
import { Body, Card, Row, Screen, colors } from '../ui/kit';
import { defaultRideName } from './gpx';
import type { RideSummary } from './recorder';
import { useRides } from './session';

const KM_TO_MI = 0.621371;

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
  const { recording, rides, loaded, start, stop, remove, exportGpx } = useRides();
  const now = useNow(recording !== null);
  const [stopping, setStopping] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const distance = (m: number) => `${((imperial ? KM_TO_MI : 1) * (m / 1000)).toFixed(1)} ${imperial ? 'mi' : 'km'}`;
  const speed = (kmh: number) => `${Math.round(imperial ? kmh * KM_TO_MI : kmh)} ${imperial ? 'mph' : 'km/h'}`;

  const onStop = async () => {
    setStopping(true);
    try {
      const result = await stop();
      if (!result.saved && result.reason === 'no-track') {
        Alert.alert('Nothing saved', 'No GPS position was recorded during this ride.');
      } else if (result.saved && result.evicted > 0) {
        Alert.alert('Ride saved', 'The oldest ride was removed to make room.');
      }
    } catch {
      Alert.alert('Could not save the ride', 'The phone storage did not accept it.');
    } finally {
      setStopping(false);
    }
  };

  const onExport = async (ride: RideSummary) => {
    setExporting(ride.id);
    try {
      await exportGpx(ride.id);
    } catch {
      Alert.alert('Could not export', 'This ride could not be read or shared.');
    } finally {
      setExporting(null);
    }
  };

  const onDelete = (ride: RideSummary) => {
    Alert.alert('Delete this ride?', `${defaultRideName(ride.startedAt)}. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          remove(ride.id).catch(() => Alert.alert('Could not delete', 'Try again.'));
        },
      },
    ]);
  };

  const elapsed = recording ? (now - recording.startedAt) / 1000 : 0;

  return (
    <Screen>
      <Card title={recording ? 'Recording' : 'New ride'}>
        {recording ? (
          <View style={styles.live} accessible accessibilityLabel={`Recording. ${distance(recording.distanceM)}, ${formatDuration(elapsed)}`}>
            <View style={styles.liveItem}>
              <Text style={styles.liveValue}>{distance(recording.distanceM)}</Text>
              <Text style={styles.liveLabel}>Distance</Text>
            </View>
            <View style={styles.liveItem}>
              <Text style={styles.liveValue}>{formatDuration(elapsed)}</Text>
              <Text style={styles.liveLabel}>Time</Text>
            </View>
          </View>
        ) : (
          <Body dim>Press Record when you set off and Stop when you arrive. Only rides you record are saved.</Body>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recording ? 'Stop recording and save the ride' : 'Start recording a ride'}
          accessibilityState={{ disabled: stopping, busy: stopping }}
          disabled={stopping}
          onPress={recording ? onStop : () => start()}
          style={({ pressed }) => [
            styles.record,
            { backgroundColor: recording ? colors.danger : colors.accent },
            (pressed || stopping) && { opacity: 0.6 },
          ]}>
          <Text style={styles.recordLabel}>{recording ? 'Stop' : 'Record'}</Text>
        </Pressable>
        {recording ? <Body dim>Keep MotoLink running: the ride uses this phone&apos;s GPS.</Body> : null}
      </Card>

      {loaded && rides.length === 0 ? (
        <Card title="Saved rides">
          <Body dim>No rides yet.</Body>
        </Card>
      ) : null}

      {rides.map((ride) => (
        <Card key={ride.id} title={defaultRideName(ride.startedAt).replace(/^Ride /, '')}>
          <Row label="Distance" value={distance(ride.distanceM)} />
          <Row label="Riding time" value={formatDuration(ride.movingSeconds)} />
          <Row label="Top speed" value={speed(ride.maxSpeedKmh)} />
          <View style={styles.actions}>
            <Action
              label={exporting === ride.id ? 'Exporting…' : 'Export GPX'}
              a11y={`Export ${defaultRideName(ride.startedAt)} as GPX`}
              disabled={exporting !== null}
              onPress={() => void onExport(ride)}
            />
            <Action
              label="Delete"
              a11y={`Delete ${defaultRideName(ride.startedAt)}`}
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
