/** Lifetime totals and distance per month over the saved rides. */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Body, Card, Row, colors } from '../ui/kit';
import { formatClimb, formatDistance, formatHours, formatSpeed, KM_TO_MI } from './format';
import { defaultRideName } from './gpx';
import type { RideSummary } from './recorder';
import { rideStats } from './stats';
import { MAX_RIDES } from './storage';

export interface StatsCardProps {
  rides: readonly RideSummary[];
  imperial?: boolean;
  /** For tests; defaults to now. */
  now?: number;
}

export function StatsCard({ rides, imperial = false, now }: StatsCardProps) {
  const { totals, months } = useMemo(() => rideStats(rides, now ?? Date.now()), [rides, now]);
  if (totals.rides === 0) return null;
  const peak = Math.max(...months.map((m) => m.distanceM), 1);
  const short = (m: number) => {
    const v = (m / 1000) * (imperial ? KM_TO_MI : 1);
    return v >= 100 ? String(Math.round(v)) : v.toFixed(v > 0 ? 1 : 0);
  };

  return (
    <Card title="Your riding" collapsible defaultOpen>
      <Row label="Rides" value={String(totals.rides)} />
      <Row label="Distance" value={formatDistance(totals.distanceM, imperial, 0)} />
      <Row label="Riding time" value={formatHours(totals.movingSeconds)} />
      {totals.longest ? (
        <Row
          label="Longest ride"
          value={`${formatDistance(totals.longest.distanceM, imperial)}, ${defaultRideName(totals.longest.startedAt).replace(/^Ride /, '')}`}
        />
      ) : null}
      <Row label="Top speed" value={formatSpeed(totals.topSpeedKmh, imperial)} />
      {totals.climbM > 0 ? <Row label="Total climb" value={formatClimb(totals.climbM, imperial)} /> : null}

      <Text style={styles.heading}>Distance per month ({imperial ? 'mi' : 'km'})</Text>
      <View style={styles.chart}>
        {months.map((m) => (
          <View
            key={m.key}
            style={styles.column}
            accessible
            accessibilityLabel={`${m.label} ${m.year}: ${formatDistance(m.distanceM, imperial)}, ${m.rides} ${m.rides === 1 ? 'ride' : 'rides'}`}>
            <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit>
              {short(m.distanceM)}
            </Text>
            <View style={styles.track}>
              <View style={[styles.bar, { height: `${Math.max(m.distanceM > 0 ? 4 : 0, (m.distanceM / peak) * 100)}%` }]} />
            </View>
            <Text style={styles.month} numberOfLines={1} adjustsFontSizeToFit>{m.label}</Text>
          </View>
        ))}
      </View>
      <Body dim>From your saved rides. Only the newest {MAX_RIDES} are kept.</Body>
    </Card>
  );
}

export default StatsCard;

const styles = StyleSheet.create({
  heading: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 6 },
  chart: { flexDirection: 'row', gap: 4, alignItems: 'flex-end' },
  column: { flex: 1, alignItems: 'center', gap: 4 },
  value: { color: colors.text, fontSize: 10, fontVariant: ['tabular-nums'] },
  track: { width: '100%', height: 80, justifyContent: 'flex-end' },
  bar: { width: '100%', backgroundColor: colors.accent, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  month: { color: colors.dim, fontSize: 11 },
});
