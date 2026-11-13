/** Lifetime totals and distance per month over the saved rides. */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useT } from '../i18n';
import { Body, Card, Row, colors } from '../ui/kit';
import { formatClimb, formatDistance, formatHours, formatSpeed, KM_TO_MI, monthShort, rideDate } from './format';
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
  const t = useT();
  const { totals, months } = useMemo(() => rideStats(rides, now ?? Date.now()), [rides, now]);
  if (totals.rides === 0) return null;
  const peak = Math.max(...months.map((m) => m.distanceM), 1);
  const short = (m: number) => {
    const v = (m / 1000) * (imperial ? KM_TO_MI : 1);
    return v >= 100 ? String(Math.round(v)) : v.toFixed(v > 0 ? 1 : 0);
  };

  return (
    <Card title={t('stats.title')} collapsible defaultOpen>
      <Row label={t('stats.rides')} value={String(totals.rides)} />
      <Row label={t('rides.distance')} value={formatDistance(totals.distanceM, imperial, 0)} />
      <Row label={t('rides.ridingTime')} value={formatHours(totals.movingSeconds)} />
      {totals.longest ? (
        <Row
          label={t('stats.longest')}
          value={`${formatDistance(totals.longest.distanceM, imperial)}, ${rideDate(totals.longest.startedAt)}`}
        />
      ) : null}
      <Row label={t('rides.topSpeed')} value={formatSpeed(totals.topSpeedKmh, imperial)} />
      {totals.climbM > 0 ? <Row label={t('stats.totalClimb')} value={formatClimb(totals.climbM, imperial)} /> : null}

      <Text style={styles.heading}>{t('stats.perMonth', { unit: imperial ? 'mi' : 'km' })}</Text>
      <View style={styles.chart}>
        {months.map((m) => (
          <View
            key={m.key}
            style={styles.column}
            accessible
            accessibilityLabel={t('stats.monthA11y', {
              month: monthShort(m.month),
              year: m.year,
              distance: formatDistance(m.distanceM, imperial),
              count: m.rides,
            })}>
            <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit>
              {short(m.distanceM)}
            </Text>
            <View style={styles.track}>
              <View style={[styles.bar, { height: `${Math.max(m.distanceM > 0 ? 4 : 0, (m.distanceM / peak) * 100)}%` }]} />
            </View>
            <Text style={styles.month} numberOfLines={1} adjustsFontSizeToFit>{monthShort(m.month)}</Text>
          </View>
        ))}
      </View>
      <Body dim>{t('stats.footer', { max: MAX_RIDES })}</Body>
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
