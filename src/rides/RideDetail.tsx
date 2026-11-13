/**
 * One saved ride: the summary, the track on a map coloured by speed, and the
 * Export / Delete actions. Shown inside RidesScreen, not as its own route.
 *
 * iOS draws the map with Apple Maps (no key needed). Android would need a
 * Google Maps key, which is not configured, so it shows the summary only.
 */
import { useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

import { useT } from '../i18n';
import { formatDuration } from '../metrics/trip';
import { Body, Card, Row, colors } from '../ui/kit';
import { formatClimb, formatDistance, formatSpeed, rideDate, rideName } from './format';
import type { RidePoint, RideSummary } from './recorder';
import { loadRide } from './storage';
import { regionForTrack, speedBands } from './track';

export interface RideDetailProps {
  ride: RideSummary;
  imperial?: boolean;
  exporting?: boolean;
  onBack: () => void;
  onExport: () => void;
  onDelete: () => void;
}

type TrackState = { status: 'loading' } | { status: 'ready'; points: RidePoint[] } | { status: 'error' };

export function RideDetail({ ride, imperial = false, exporting = false, onBack, onExport, onDelete }: RideDetailProps) {
  const t = useT();
  const [track, setTrack] = useState<TrackState>({ status: 'loading' });
  const name = rideName(ride.startedAt);

  useEffect(() => {
    let live = true;
    setTrack({ status: 'loading' });
    loadRide(ride.id)
      .then((r) => live && setTrack(r ? { status: 'ready', points: r.points } : { status: 'error' }))
      .catch(() => live && setTrack({ status: 'error' }));
    return () => {
      live = false;
    };
  }, [ride.id]);

  // Android's back gesture goes back to the list, like the Back button.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('rideDetail.backA11y')}
        onPress={onBack}
        hitSlop={8}
        style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
        <Text style={styles.backLabel}>{t('rideDetail.back')}</Text>
      </Pressable>

      <Card title={rideDate(ride.startedAt)}>
        <Row label={t('rideDetail.date')} value={new Date(ride.startedAt).toLocaleString()} />
        <Row label={t('rides.distance')} value={formatDistance(ride.distanceM, imperial)} />
        <Row label={t('rides.ridingTime')} value={formatDuration(ride.movingSeconds)} />
        <Row label={t('rideDetail.totalTime')} value={formatDuration(ride.totalSeconds)} />
        <Row label={t('rideDetail.avgSpeed')} value={formatSpeed(ride.avgSpeedKmh, imperial)} />
        <Row label={t('rides.topSpeed')} value={formatSpeed(ride.maxSpeedKmh, imperial)} />
        {ride.elevationGainM > 0 ? <Row label={t('rideDetail.climb')} value={formatClimb(ride.elevationGainM, imperial)} /> : null}
      </Card>

      <Card title={t('rideDetail.track')}>
        {Platform.OS === 'android' ? (
          <Body dim>{t('rideDetail.androidMap')}</Body>
        ) : track.status === 'loading' ? (
          <Body dim>{t('rideDetail.loading')}</Body>
        ) : track.status === 'error' ? (
          <Body dim>{t('rideDetail.trackError')}</Body>
        ) : (
          <TrackMap points={track.points} imperial={imperial} name={name} />
        )}
      </Card>

      <View style={styles.actions}>
        <Action
          label={exporting ? t('rides.exporting') : t('rides.exportGpx')}
          a11y={t('rides.exportA11y', { name })}
          disabled={exporting}
          onPress={onExport}
        />
        <Action label={t('common.delete')} a11y={t('rides.deleteA11y', { name })} danger onPress={onDelete} />
      </View>
    </>
  );
}

function TrackMap({ points, imperial, name }: { points: RidePoint[]; imperial: boolean; name: string }) {
  const t = useT();
  const region = useMemo(() => regionForTrack(points), [points]);
  // The language is a dependency: the legend labels are built in it.
  const { segments, legend } = useMemo(() => speedBands(points, { imperial }), [points, imperial, t]);
  if (!region || points.length === 0) return <Body dim>{t('rideDetail.noTrack')}</Body>;
  const first = points[0];
  const last = points[points.length - 1];
  const usedBands = new Set(segments.map((s) => s.band));

  return (
    <View style={styles.mapBlock}>
      <View
        style={styles.mapFrame}
        accessible
        accessibilityRole="image"
        accessibilityLabel={t('rideDetail.mapA11y', { name })}>
        <MapView
          style={StyleSheet.absoluteFill}
          initialRegion={region}
          userInterfaceStyle="dark"
          showsPointsOfInterests={false}
          pitchEnabled={false}
          rotateEnabled={false}
          toolbarEnabled={false}>
          {segments.map((s, i) => (
            <Polyline
              key={`${i}-${s.band}`}
              coordinates={s.coordinates}
              strokeColor={s.color}
              strokeWidth={5}
              lineCap="round"
              lineJoin="round"
            />
          ))}
          <Marker coordinate={{ latitude: first.lat, longitude: first.lon }} title={t('rideDetail.start')} anchor={{ x: 0.5, y: 0.5 }}>
            <Pin text={t('rideDetail.start')} color={colors.ok} />
          </Marker>
          {points.length > 1 ? (
            <Marker coordinate={{ latitude: last.lat, longitude: last.lon }} title={t('rideDetail.end')} anchor={{ x: 0.5, y: 0.5 }}>
              <Pin text={t('rideDetail.end')} color={colors.danger} />
            </Marker>
          ) : null}
        </MapView>
      </View>

      <Text style={styles.legendTitle}>{t('rideDetail.speed')}</Text>
      <View style={styles.legend}>
        {legend.map((b) => (
          <View
            key={b.index}
            style={styles.legendItem}
            accessible
            accessibilityLabel={usedBands.has(b.index) ? b.label : t('rideDetail.notReached', { band: b.label })}>
            <View style={[styles.swatch, { backgroundColor: b.color }]} />
            <Text style={[styles.legendLabel, !usedBands.has(b.index) && { color: colors.dim }]}>{b.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A labelled map pin: the word says which end it is, the colour only helps. */
function Pin({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.pin, { borderColor: color }]}>
      <Text style={styles.pinText}>{text}</Text>
    </View>
  );
}

/** Outline button with a label naming the ride, same look as the list's actions. */
function Action(props: { label: string; a11y: string; onPress: () => void; danger?: boolean; disabled?: boolean }) {
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
      <Text style={[styles.actionLabel, { color: props.danger ? colors.danger : colors.text }]}>{props.label}</Text>
    </Pressable>
  );
}

export default RideDetail;

const styles = StyleSheet.create({
  back: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: 16 },
  backLabel: { color: colors.accent, fontSize: 17, fontWeight: '700' },
  mapBlock: { gap: 10 },
  mapFrame: { height: 320, borderRadius: 12, overflow: 'hidden', backgroundColor: colors.bg },
  pin: { backgroundColor: colors.card, borderWidth: 2, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  pinText: { color: colors.text, fontSize: 12, fontWeight: '800' },
  legendTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  swatch: { width: 28, height: 6, borderRadius: 3 },
  legendLabel: { color: colors.text, fontSize: 14, fontVariant: ['tabular-nums'] },
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
