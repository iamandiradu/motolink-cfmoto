import { dispatchDashAction } from '../../app-state/controller';
import { useAppState } from '../../app-state/store';
import { compassPoint, formatDuration, gpsQuality } from '../../metrics/trip';
import { useT } from '../../i18n';
import { Body, Button, Card, Row, Screen, confirm } from '../../ui/kit';

const KM_TO_MI = 0.621371;

export default function MetricsScreen() {
  const t = useT();
  const m = useAppState((s) => s.metrics);
  const imperial = useAppState((s) => s.settings.units === 'imperial');

  const speed = (kmh: number | null) =>
    kmh === null ? '–' : `${Math.round(imperial ? kmh * KM_TO_MI : kmh)} ${imperial ? 'mph' : 'km/h'}`;
  const distance = (km: number) => `${(imperial ? km * KM_TO_MI : km).toFixed(1)} ${imperial ? 'mi' : 'km'}`;
  const quality = gpsQuality(m.accuracyM);

  return (
    <Screen>
      <Card title={t('metrics.now')}>
        {/* One explanation instead of the same "no data" on every row. */}
        {quality === 'none' ? (
          <Body dim>{t('metrics.waitingGps')}</Body>
        ) : null}
        <Row label={t('metrics.speed')} value={speed(m.speedKmh)} />
        <Row
          label={t('metrics.direction')}
          value={m.headingDeg === null ? '–' : `${compassPoint(m.headingDeg)} ${Math.round(m.headingDeg)}°`}
        />
        <Row label={t('metrics.altitude')} value={m.altitudeM === null ? '–' : `${Math.round(m.altitudeM)} m`} />
        <Row
          label={t('metrics.lean')}
          value={
            m.leanDeg === null
              ? '–'
              : Math.abs(m.leanDeg) < 1
                ? t('metrics.upright')
                : t(m.leanDeg > 0 ? 'metrics.leanRight' : 'metrics.leanLeft', { deg: Math.round(Math.abs(m.leanDeg)) })
          }
        />
        <Row
          label={t('metrics.gpsSignal')}
          value={
            m.accuracyM === null
              ? t('metrics.gps.none')
              : t('metrics.gpsValue', { quality: t(`metrics.gps.${quality}`), m: Math.round(m.accuracyM) })
          }
        />
      </Card>

      <Card title={t('metrics.trip')}>
        <Row label={t('metrics.distance')} value={distance(m.tripKm)} />
        <Row label={t('metrics.ridingTime')} value={formatDuration(m.movingSeconds)} />
        <Row label={t('metrics.avgSpeed')} value={speed(m.avgSpeedKmh)} />
        <Row label={t('metrics.topSpeed')} value={speed(m.maxSpeedKmh)} />
        <Row label={t('metrics.maxLean')} value={`${Math.round(m.maxLeanDeg)}°`} />
        <Button
          label={t('metrics.resetTrip')}
          kind="danger"
          onPress={() =>
            confirm(t('metrics.resetTitle'), t('metrics.resetBody'), t('metrics.resetAction'), () =>
              dispatchDashAction('resetTrip'),
            )
          }
        />
      </Card>

      <Card title={t('metrics.aboutLeanTitle')}>
        <Body dim>{t('metrics.aboutLeanBody')}</Body>
      </Card>

      <Card title={t('metrics.sourcesTitle')}>
        <Body dim>{t('metrics.sourcesBody')}</Body>
      </Card>
    </Screen>
  );
}
