import { dispatchDashAction } from '../../app-state/controller';
import { useAppState } from '../../app-state/store';
import { compassPoint, formatDuration, gpsQuality } from '../../metrics/trip';
import { Body, Button, Card, Row, Screen, confirm } from '../../ui/kit';

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
    kmh === null ? '–' : `${Math.round(imperial ? kmh * KM_TO_MI : kmh)} ${imperial ? 'mph' : 'km/h'}`;
  const distance = (km: number) => `${(imperial ? km * KM_TO_MI : km).toFixed(1)} ${imperial ? 'mi' : 'km'}`;
  const quality = gpsQuality(m.accuracyM);

  return (
    <Screen>
      <Card title="Now">
        {/* One explanation instead of the same "no data" on every row. */}
        {quality === 'none' ? (
          <Body dim>Waiting for GPS. It needs a view of the sky, and location access for MotoLink in iOS Settings.</Body>
        ) : null}
        <Row label="Speed" value={speed(m.speedKmh)} />
        <Row
          label="Direction"
          value={m.headingDeg === null ? '–' : `${compassPoint(m.headingDeg)} ${Math.round(m.headingDeg)}°`}
        />
        <Row label="Altitude" value={m.altitudeM === null ? '–' : `${Math.round(m.altitudeM)} m`} />
        <Row
          label="Lean (estimate)"
          value={
            m.leanDeg === null
              ? '–'
              : Math.abs(m.leanDeg) < 1
                ? 'Upright'
                : `${Math.round(Math.abs(m.leanDeg))}° ${m.leanDeg > 0 ? 'right' : 'left'}`
          }
        />
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
        <Row label="Max lean (estimate)" value={`${Math.round(m.maxLeanDeg)}°`} />
        <Button
          label="Reset trip"
          kind="danger"
          onPress={() =>
            confirm('Reset trip?', 'Distance, time, speeds and max lean go back to zero.', 'Reset', () =>
              dispatchDashAction('resetTrip'),
            )
          }
        />
      </Card>

      <Card title="About lean angle">
        <Body dim>
          Lean is an estimate and may be inaccurate. It is calculated from GPS speed and how hard the bike is turning,
          using this phone&apos;s gyroscope and accelerometer, not measured by a sensor on the bike. Expect it to be off
          by several degrees, to pick the side a moment late, and to read upright below 15 km/h. Do not use it to
          judge how far you can lean.
        </Body>
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
