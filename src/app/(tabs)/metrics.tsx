import { dispatchDashAction } from '../../app-state/controller';
import { useAppState } from '../../app-state/store';
import { compassPoint, formatDuration, gpsQuality } from '../../metrics/trip';
import { Body, Button, Card, Row, Screen } from '../../ui/kit';

const KM_TO_MI = 0.621371;

const GPS_TEXT = {
  none: 'No signal yet',
  poor: 'Weak',
  good: 'Good',
} as const;

export default function MetricsScreen() {
  const m = useAppState((s) => s.metrics);
  const imperial = useAppState((s) => s.settings.units === 'imperial');

  const speed = (kmh: number | null) =>
    kmh === null ? 'No data' : `${Math.round(imperial ? kmh * KM_TO_MI : kmh)} ${imperial ? 'mph' : 'km/h'}`;
  const distance = (km: number) => `${(imperial ? km * KM_TO_MI : km).toFixed(1)} ${imperial ? 'mi' : 'km'}`;
  const quality = gpsQuality(m.accuracyM);

  return (
    <Screen>
      <Card title="Now">
        <Row label="Speed" value={speed(m.speedKmh)} />
        <Row
          label="Direction"
          value={m.headingDeg === null ? 'No data' : `${compassPoint(m.headingDeg)} ${Math.round(m.headingDeg)}°`}
        />
        <Row label="Altitude" value={m.altitudeM === null ? 'No data' : `${Math.round(m.altitudeM)} m`} />
        <Row
          label="GPS signal"
          value={m.accuracyM === null ? GPS_TEXT.none : `${GPS_TEXT[quality]} (±${Math.round(m.accuracyM)} m)`}
        />
      </Card>

      <Card title="Trip">
        <Row label="Distance" value={distance(m.tripKm)} />
        <Row label="Riding time" value={formatDuration(m.movingSeconds)} />
        <Row label="Average speed" value={speed(m.avgSpeedKmh)} />
        <Row label="Top speed" value={speed(m.maxSpeedKmh)} />
        <Button label="Reset trip" kind="danger" onPress={() => dispatchDashAction('resetTrip')} />
      </Card>

      <Card title="Where these come from">
        <Body dim>
          All values come from this phone&apos;s GPS, so they work with the phone in a pocket. Riding time and averages
          count only while moving. The bike itself shares nothing: on a 450 MT without the T-Box, no speed, rpm, gear
          or fuel leaves the dash over Wi-Fi or Bluetooth.
        </Body>
      </Card>
    </Screen>
  );
}
