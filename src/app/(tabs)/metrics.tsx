import { calibrateLean, dispatchDashAction } from '../../app-state/controller';
import { useAppState } from '../../app-state/store';
import { compassPoint, formatDuration } from '../../metrics/trip';
import { Body, Button, Card, Row, Screen } from '../../ui/kit';

const KM_TO_MI = 0.621371;

export default function MetricsScreen() {
  const m = useAppState((s) => s.metrics);
  const imperial = useAppState((s) => s.settings.units === 'imperial');

  const speed = (kmh: number | null) =>
    kmh === null ? 'No data' : `${Math.round(imperial ? kmh * KM_TO_MI : kmh)} ${imperial ? 'mph' : 'km/h'}`;
  const distance = (km: number) => `${(imperial ? km * KM_TO_MI : km).toFixed(1)} ${imperial ? 'mi' : 'km'}`;
  const engine = (value: number | null, unit: string) => (value === null ? 'No source' : `${Math.round(value)} ${unit}`);

  return (
    <Screen>
      <Card title="Now">
        <Row label="Speed" value={speed(m.speedKmh)} />
        <Row
          label="Heading"
          value={m.headingDeg === null ? 'No data' : `${compassPoint(m.headingDeg)} ${Math.round(m.headingDeg)}°`}
        />
        <Row label="Altitude" value={m.altitudeM === null ? 'No data' : `${Math.round(m.altitudeM)} m`} />
        <Row
          label="Lean"
          value={
            m.leanDeg === null
              ? 'No data'
              : `${Math.abs(Math.round(m.leanDeg))}° ${Math.abs(m.leanDeg) < 1 ? '' : m.leanDeg > 0 ? 'right' : 'left'}`
          }
        />
        <Button label="Set lean to zero (bike upright)" kind="plain" onPress={calibrateLean} />
      </Card>

      <Card title="Trip">
        <Row label="Distance" value={distance(m.tripKm)} />
        <Row label="Riding time" value={formatDuration(m.movingSeconds)} />
        <Row label="Average speed" value={speed(m.avgSpeedKmh)} />
        <Row label="Top speed" value={speed(m.maxSpeedKmh)} />
        <Row label="Max lean" value={`${Math.round(m.maxLeanDeg)}°`} />
        <Button label="Reset trip" kind="danger" onPress={() => dispatchDashAction('resetTrip')} />
      </Card>

      <Card title="Engine">
        <Row label="RPM" value={engine(m.rpm, 'rpm')} />
        <Row label="Coolant" value={engine(m.coolantC, '°C')} />
        <Row label="Battery" value={m.batteryV === null ? 'No source' : `${m.batteryV.toFixed(1)} V`} />
        <Body dim>
          The dash does not share engine data with a phone: on a 450 MT without the T-Box, nothing about speed, rpm,
          gear or fuel leaves the bike over Wi-Fi or Bluetooth. Speed, heading and lean above come from this phone.
          Engine values need an OBD-II Bluetooth adapter on the diagnostic plug, which this app does not read yet.
        </Body>
      </Card>
    </Screen>
  );
}
