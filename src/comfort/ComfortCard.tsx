/** Settings for riding comfort: alerts, voice, day/night theme, glove mode. Props only. */
import { Body, Button, Card, Choice, Label, Row, Stepper } from '../ui/kit';
import type { ComfortSettings } from './alerts';
import type { GloveMode } from './glove';

const KM_TO_MI = 0.621371;

export interface ComfortCardProps {
  settings: ComfortSettings;
  onChange: (patch: Partial<ComfortSettings>) => void;
  /** Show mph and miles. Settings stay in km/h and km. */
  imperial: boolean;
  /** Dash themes the rider can pick for day and night. */
  themes: readonly { value: string; label: string }[];
  /** "I just refuelled": the caller resets the distance (fuel.refuel). */
  onRefuel: () => void;
  /** Speak a sample sentence. */
  onTestVoice: () => void;
}

const onOff = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
] as const;

const GLOVE_OPTIONS: readonly { value: GloveMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'whenConnected', label: 'When on the bike' },
];

export function ComfortCard({ settings, onChange, imperial, themes, onRefuel, onTestVoice }: ComfortCardProps) {
  const factor = imperial ? KM_TO_MI : 1;
  const toShown = (km: number) => Math.round(km * factor);
  const fromShown = (shown: number) => Math.round(shown / factor);
  const speedUnit = imperial ? ' mph' : ' km/h';
  const distUnit = imperial ? ' mi' : ' km';

  return (
    <>
      <Card title="Alerts">
        <Label>Speed warning</Label>
        <Body dim>Shown on the dash and spoken when you go over your limit.</Body>
        <Choice
          value={settings.speedWarningKmh === null ? 'off' : 'on'}
          options={onOff}
          onChange={(v) => onChange({ speedWarningKmh: v === 'on' ? (imperial ? fromShown(70) : 100) : null })}
        />
        {settings.speedWarningKmh !== null ? (
          <Stepper
            label="Limit"
            value={toShown(settings.speedWarningKmh)}
            unit={speedUnit}
            min={imperial ? 20 : 30}
            max={imperial ? 130 : 200}
            step={5}
            onChange={(v) => onChange({ speedWarningKmh: fromShown(v) })}
          />
        ) : null}

        <Label>Fuel reminder</Label>
        <Body dim>The bike does not send its fuel level. Set how far a full tank takes you.</Body>
        <Choice
          value={settings.fuelRangeKm === null ? 'off' : 'on'}
          options={onOff}
          onChange={(v) => onChange({ fuelRangeKm: v === 'on' ? (imperial ? fromShown(150) : 250) : null })}
        />
        {settings.fuelRangeKm !== null ? (
          <>
            <Stepper
              label="Full tank"
              value={toShown(settings.fuelRangeKm)}
              unit={distUnit}
              min={imperial ? 30 : 50}
              max={imperial ? 400 : 600}
              step={10}
              onChange={(v) => onChange({ fuelRangeKm: fromShown(v) })}
            />
            <Row label="Since refuel" value={`${toShown(settings.kmSinceRefuel)}${distUnit}`} />
            <Button label="I just refuelled" kind="plain" onPress={onRefuel} />
          </>
        ) : null}

        <Label>Low phone battery</Label>
        <Choice
          value={settings.lowBatteryPercent === null ? 'off' : 'on'}
          options={onOff}
          onChange={(v) => onChange({ lowBatteryPercent: v === 'on' ? 20 : null })}
        />
      </Card>

      <Card title="Voice">
        <Body dim>Alerts are spoken through your headset.</Body>
        <Choice value={settings.voice ? 'on' : 'off'} options={onOff} onChange={(v) => onChange({ voice: v === 'on' })} />
        <Button label="Test voice" kind="plain" disabled={!settings.voice} onPress={onTestVoice} />
      </Card>

      <Card title="Day and night colours">
        <Body dim>Switches the dash colours at sunrise and sunset, from your location.</Body>
        <Choice
          value={settings.autoTheme ? 'on' : 'off'}
          options={onOff}
          onChange={(v) => onChange({ autoTheme: v === 'on' })}
        />
        {settings.autoTheme ? (
          <>
            <Label>By day</Label>
            <Choice value={settings.dayTheme} options={themes} onChange={(dayTheme) => onChange({ dayTheme })} />
            <Label>By night</Label>
            <Choice value={settings.nightTheme} options={themes} onChange={(nightTheme) => onChange({ nightTheme })} />
          </>
        ) : null}
      </Card>

      <Card title="Glove mode">
        <Body dim>Bigger buttons and less text on the phone.</Body>
        <Choice value={settings.gloveMode} options={GLOVE_OPTIONS} onChange={(gloveMode) => onChange({ gloveMode })} />
      </Card>
    </>
  );
}
