import { useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';

import { Share } from 'react-native';

import {
  changeComfort,
  chooseBikeProfile,
  importBikeProfile,
  markRefuelled,
  setBikeBluetooth,
  setDashTheme,
  testVoice,
} from '../../app-state/controller';
import { restoreHints, saveSettings, setState, useAppState } from '../../app-state/store';
import { allProfiles, exportBikeReport } from '../../bikes';
import { BikeCard } from '../../bikes/BikeCard';
import { ComfortCard } from '../../comfort/ComfortCard';
import { THEMES, themeLabel } from '../../dash/controller';
import { shareReport } from '../../diagnostics/share';
import { LANGUAGES, LANGUAGE_NAMES, LanguageSetting, useT } from '../../i18n';
import { REDIRECT_URI } from '../../spotify/api';
import { connectSpotify, disconnectSpotify, setSpotifyClientId } from '../../spotify/session';
import { Body, Button, Card, Choice, Label, Row, Screen, colors } from '../../ui/kit';

export default function SettingsScreen() {
  const t = useT();
  const settings = useAppState((s) => s.settings);
  const theme = useAppState((s) => s.dash.theme);
  const logs = useAppState((s) => s.logs);
  const outputs = useAppState((s) => s.bluetoothOutputs);
  const testPattern = useAppState((s) => s.testPattern);
  const spotify = useAppState((s) => s.spotify);
  const bike = useAppState((s) => s.bike);
  const bikeMatch = useAppState((s) => s.bikeMatch);
  const learnedBike = useAppState((s) => s.learnedBike);
  const customProfiles = useAppState((s) => s.customProfiles);
  const [profileJson, setProfileJson] = useState('');
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [clientId, setClientId] = useState(settings.spotifyClientId);
  const candidate = outputs.find((name) => name !== settings.bikeBluetooth) ?? null;
  // Each language is named in itself, so a rider can find theirs whatever is shown now.
  const languageOptions: { value: LanguageSetting; label: string }[] = [
    { value: 'system', label: t('settings.languageSystem') },
    ...LANGUAGES.map((value) => ({ value, label: LANGUAGE_NAMES[value] })),
  ];
  const themeOptions = THEMES.map((value) => ({ value, label: themeLabel(value) }));

  return (
    <Screen>
      <Card title={t('settings.language')}>
        <Choice value={settings.language} onChange={(language) => saveSettings({ language })} options={languageOptions} />
      </Card>

      <Card title={t('settings.dashPicture')}>
        <Label>{t('settings.colours')}</Label>
        <Choice value={theme} onChange={setDashTheme} options={themeOptions} />
        <Label>{t('settings.units')}</Label>
        <Choice
          value={settings.units}
          onChange={(units) => saveSettings({ units })}
          options={[
            { value: 'metric', label: 'km/h' },
            { value: 'imperial', label: 'mph' },
          ]}
        />
        <Label>{t('settings.quality')}</Label>
        <Body dim>{t('settings.qualityBody')}</Body>
        <Choice
          value={settings.bitrateKbps}
          onChange={(bitrateKbps) => saveSettings({ bitrateKbps })}
          options={[
            { value: 800, label: t('settings.low') },
            { value: 1500, label: t('settings.balanced') },
            { value: 2500, label: t('settings.high') },
          ]}
        />
      </Card>

      <ComfortCard
        settings={settings.comfort}
        onChange={changeComfort}
        imperial={settings.units === 'imperial'}
        themes={themeOptions}
        onRefuel={markRefuelled}
        onTestVoice={testVoice}
      />

      <Card title={t('settings.spotifyTitle')}>
        {spotify.connected ? (
          <>
            <Body>{t('settings.spotifyConnected')}</Body>
            {spotify.playback ? (
              <Row label={t('settings.now')} value={`${spotify.playback.title} · ${spotify.playback.artist}`} />
            ) : null}
            <Button label={t('settings.disconnectSpotify')} kind="plain" onPress={() => void disconnectSpotify()} />
          </>
        ) : (
          <>
            <Body dim>{t('settings.spotifyIntro')}</Body>
            <Body dim>{t('settings.spotifyStep1')}</Body>
            <Body dim selectable>
              {t('settings.spotifyStep2', { uri: REDIRECT_URI })}
            </Body>
            <Body dim>{t('settings.spotifyStep3')}</Body>
            <TextInput
              value={clientId}
              onChangeText={setClientId}
              onEndEditing={() => setSpotifyClientId(clientId)}
              placeholder={t('settings.clientIdPlaceholder')}
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel={t('settings.clientIdA11y')}
            />
            <Button
              label={t('settings.connectSpotify')}
              disabled={clientId.trim().length === 0}
              onPress={() => {
                setSpotifyClientId(clientId);
                void connectSpotify();
              }}
            />
          </>
        )}
        {spotify.error ? <Text style={styles.error}>{spotify.error}</Text> : null}
        <Body dim>{t('settings.spotifyNote')}</Body>
      </Card>

      <Card title={t('settings.autoStartTitle')}>
        {settings.bikeBluetooth ? (
          <>
            <Body>
              {t('settings.bikeBluetooth', { name: settings.bikeBluetooth })}
              {outputs.includes(settings.bikeBluetooth) ? t('settings.connectedNow') : ''}
            </Body>
            <Choice
              value={settings.autoStart ? 'on' : 'off'}
              onChange={(value) => saveSettings({ autoStart: value === 'on' })}
              options={[
                { value: 'on', label: t('settings.offerMirroring') },
                { value: 'off', label: t('settings.doNothing') },
              ]}
            />
            <Body dim>{t('settings.autoStartBody')}</Body>
            <Button label={t('settings.forgetBluetooth')} kind="plain" onPress={() => setBikeBluetooth(null)} />
          </>
        ) : (
          <Body dim>{t('settings.autoStartEmpty')}</Body>
        )}
        {candidate ? (
          <Button
            label={t('settings.useAsBike', { name: candidate })}
            kind={settings.bikeBluetooth ? 'plain' : 'primary'}
            onPress={() => setBikeBluetooth(candidate)}
          />
        ) : !settings.bikeBluetooth ? (
          <Body dim>{t('settings.noBluetooth')}</Body>
        ) : null}
      </Card>

      <Card title={t('settings.connection')}>
        <Label>{t('settings.whenOpens')}</Label>
        <Choice
          value={settings.autoConnect ? 'on' : 'off'}
          onChange={(value) => saveSettings({ autoConnect: value === 'on' })}
          options={[
            { value: 'on', label: t('settings.connectByItself') },
            { value: 'off', label: t('settings.waitForMe') },
          ]}
        />
      </Card>

      {bike && bikeMatch ? (
        <>
          <BikeCard
            match={bikeMatch}
            learned={learnedBike}
            profiles={allProfiles(customProfiles)}
            manualId={learnedBike?.chosenProfileId ?? null}
            onChooseProfile={chooseBikeProfile}
            canShare={learnedBike !== null}
            onShare={() => {
              if (!learnedBike) return;
              const message = exportBikeReport({ learned: learnedBike, match: bikeMatch, credentials: bike });
              void Share.share({ title: t('settings.shareBikeTitle'), message }).catch(() => undefined);
            }}
          />
          <Card title={t('settings.addSharedTitle')} collapsible>
            <Body dim>{t('settings.addSharedBody')}</Body>
            <TextInput
              value={profileJson}
              onChangeText={setProfileJson}
              placeholder={t('settings.profilePlaceholder')}
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={[styles.input, styles.multiline]}
              accessibilityLabel={t('settings.profileA11y')}
            />
            <Button
              label={t('settings.addBike')}
              kind="plain"
              disabled={profileJson.trim().length === 0}
              onPress={() => {
                void importBikeProfile(profileJson).then((error) => {
                  setImportMessage(error ?? t('settings.bikeAdded'));
                  if (!error) setProfileJson('');
                });
              }}
            />
            {importMessage ? <Body dim>{importMessage}</Body> : null}
          </Card>
        </>
      ) : null}

      <Card title={t('settings.reportTitle')}>
        <Body dim>{t('settings.reportBody')}</Body>
        <Button label={t('settings.shareReport')} onPress={() => void shareReport().catch(() => undefined)} />
      </Card>

      <Card title={t('settings.testing')} collapsible>
        <Label>{t('settings.testPicture')}</Label>
        <Body dim>{t('settings.testPictureBody')}</Body>
        <Choice
          value={testPattern ? 'on' : 'off'}
          onChange={(value) => setState({ testPattern: value === 'on' })}
          options={[
            { value: 'off', label: t('settings.ridePages') },
            { value: 'on', label: t('settings.testPicture') },
          ]}
        />
        <Label>{t('settings.simAddress')}</Label>
        <Body dim>{t('settings.simBody')}</Body>
        <TextInput
          value={settings.dashHostOverride}
          onChangeText={(dashHostOverride) => saveSettings({ dashHostOverride })}
          placeholder={t('settings.simPlaceholder')}
          placeholderTextColor={colors.dim}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="numbers-and-punctuation"
          style={styles.input}
          accessibilityLabel={t('settings.simAddress')}
        />
      </Card>

      <Card title={t('settings.troubleTitle')} collapsible>
        <Body dim>{t('settings.troubleBody')}</Body>
        <Label>{t('settings.phoneType')}</Label>
        <Choice
          value={settings.identityOs}
          onChange={(identityOs) => saveSettings({ identityOs })}
          options={[
            { value: 'Android', label: t('settings.androidDefault') },
            { value: 'iOS', label: 'iOS' },
          ]}
        />
        <Label>{t('settings.dashGeneration')}</Label>
        <Body dim>{t('settings.dashGenerationBody')}</Body>
        <Choice
          value={settings.supportFunction}
          onChange={(supportFunction) => saveSettings({ supportFunction })}
          options={[
            { value: 'auto', label: t('settings.fromProfile') },
            { value: 0, label: t('settings.olderDash') },
            { value: 128, label: t('settings.newerDash') },
          ]}
        />
      </Card>

      <Card title={t('settings.tipsTitle')} collapsible>
        <Body dim>{t('settings.tipsBody')}</Body>
        <Button
          label={t('settings.showTips')}
          kind="plain"
          disabled={settings.dismissedHints.length === 0}
          onPress={restoreHints}
        />
        <Button
          label={t('settings.runGuide')}
          kind="plain"
          onPress={() => saveSettings({ onboardingDone: false, onboardingStep: null })}
        />
      </Card>

      <Card title={t('settings.log')} collapsible>
        <Text style={styles.log} selectable>
          {logs.length === 0 ? t('settings.logEmpty') : logs.slice(-80).join('\n')}
        </Text>
        <Button label={t('settings.clearLog')} kind="plain" disabled={logs.length === 0} onPress={() => setState({ logs: [] })} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    color: colors.text,
    fontSize: 15,
  },
  multiline: { minHeight: 96, paddingVertical: 10, textAlignVertical: 'top' },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  log: { color: colors.dim, fontSize: 12, lineHeight: 17, fontFamily: 'Menlo' },
});
