/** Settings for riding comfort: alerts, voice, day/night theme, glove mode. Props only. */
import { useT } from '../i18n';
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

export function ComfortCard({ settings, onChange, imperial, themes, onRefuel, onTestVoice }: ComfortCardProps) {
  const t = useT();
  // Built on each render so the labels follow the app language.
  const onOff = [
    { value: 'off', label: t('common.off') },
    { value: 'on', label: t('common.on') },
  ] as const;
  const gloveOptions: readonly { value: GloveMode; label: string }[] = [
    { value: 'off', label: t('common.off') },
    { value: 'on', label: t('common.on') },
    { value: 'whenConnected', label: t('comfort.whenConnected') },
  ];
  const factor = imperial ? KM_TO_MI : 1;
  const toShown = (km: number) => Math.round(km * factor);
  const fromShown = (shown: number) => Math.round(shown / factor);
  const speedUnit = imperial ? ' mph' : ' km/h';
  const distUnit = imperial ? ' mi' : ' km';

  return (
    <>
      <Card title={t('comfort.alertsTitle')}>
        <Label>{t('comfort.speedWarning')}</Label>
        <Body dim>{t('comfort.speedBody')}</Body>
        <Choice
          value={settings.speedWarningKmh === null ? 'off' : 'on'}
          options={onOff}
          onChange={(v) => onChange({ speedWarningKmh: v === 'on' ? (imperial ? fromShown(70) : 100) : null })}
        />
        {settings.speedWarningKmh !== null ? (
          <Stepper
            label={t('comfort.limit')}
            value={toShown(settings.speedWarningKmh)}
            unit={speedUnit}
            min={imperial ? 20 : 30}
            max={imperial ? 130 : 200}
            step={5}
            onChange={(v) => onChange({ speedWarningKmh: fromShown(v) })}
          />
        ) : null}

        <Label>{t('comfort.fuel')}</Label>
        <Body dim>{t('comfort.fuelBody')}</Body>
        <Choice
          value={settings.fuelRangeKm === null ? 'off' : 'on'}
          options={onOff}
          onChange={(v) => onChange({ fuelRangeKm: v === 'on' ? (imperial ? fromShown(150) : 250) : null })}
        />
        {settings.fuelRangeKm !== null ? (
          <>
            <Stepper
              label={t('comfort.fullTank')}
              value={toShown(settings.fuelRangeKm)}
              unit={distUnit}
              min={imperial ? 30 : 50}
              max={imperial ? 400 : 600}
              step={10}
              onChange={(v) => onChange({ fuelRangeKm: fromShown(v) })}
            />
            <Row label={t('comfort.sinceRefuel')} value={`${toShown(settings.kmSinceRefuel)}${distUnit}`} />
            <Button label={t('comfort.refuelled')} kind="plain" onPress={onRefuel} />
          </>
        ) : null}

        <Label>{t('comfort.lowBattery')}</Label>
        <Choice
          value={settings.lowBatteryPercent === null ? 'off' : 'on'}
          options={onOff}
          onChange={(v) => onChange({ lowBatteryPercent: v === 'on' ? 20 : null })}
        />
      </Card>

      <Card title={t('comfort.voiceTitle')}>
        <Body dim>{t('comfort.voiceBody')}</Body>
        <Choice value={settings.voice ? 'on' : 'off'} options={onOff} onChange={(v) => onChange({ voice: v === 'on' })} />
        <Button label={t('comfort.testVoice')} kind="plain" disabled={!settings.voice} onPress={onTestVoice} />
      </Card>

      <Card title={t('comfort.dayNightTitle')}>
        <Body dim>{t('comfort.dayNightBody')}</Body>
        <Choice
          value={settings.autoTheme ? 'on' : 'off'}
          options={onOff}
          onChange={(v) => onChange({ autoTheme: v === 'on' })}
        />
        {settings.autoTheme ? (
          <>
            <Label>{t('comfort.byDay')}</Label>
            <Choice value={settings.dayTheme} options={themes} onChange={(dayTheme) => onChange({ dayTheme })} />
            <Label>{t('comfort.byNight')}</Label>
            <Choice value={settings.nightTheme} options={themes} onChange={(nightTheme) => onChange({ nightTheme })} />
          </>
        ) : null}
      </Card>

      <Card title={t('comfort.gloveTitle')}>
        <Body dim>{t('comfort.gloveBody')}</Body>
        <Choice value={settings.gloveMode} options={gloveOptions} onChange={(gloveMode) => onChange({ gloveMode })} />
      </Card>
    </>
  );
}
