import { useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';

import { setBikeBluetooth, setDashTheme } from '../../app-state/controller';
import { restoreHints, saveSettings, setState, useAppState } from '../../app-state/store';
import { THEMES, THEME_LABELS } from '../../dash/controller';
import { REDIRECT_URI } from '../../spotify/api';
import { connectSpotify, disconnectSpotify, setSpotifyClientId } from '../../spotify/session';
import { Body, Button, Card, Choice, Row, Screen, colors } from '../../ui/kit';

export default function SettingsScreen() {
  const settings = useAppState((s) => s.settings);
  const theme = useAppState((s) => s.dash.theme);
  const logs = useAppState((s) => s.logs);
  const outputs = useAppState((s) => s.bluetoothOutputs);
  const spotify = useAppState((s) => s.spotify);
  const [clientId, setClientId] = useState(settings.spotifyClientId);
  const candidate = outputs.find((name) => name !== settings.bikeBluetooth) ?? null;

  return (
    <Screen>
      <Card title="Connection">
        <Body dim>Connect when the app opens.</Body>
        <Choice
          value={settings.autoConnect ? 'on' : 'off'}
          onChange={(value) => saveSettings({ autoConnect: value === 'on' })}
          options={[
            { value: 'on', label: 'Automatic' },
            { value: 'off', label: 'Manual' },
          ]}
        />
      </Card>

      <Card title="Start when the bike connects">
        {settings.bikeBluetooth ? (
          <>
            <Body>
              Bike Bluetooth: {settings.bikeBluetooth}
              {outputs.includes(settings.bikeBluetooth) ? ' (connected now)' : ''}
            </Body>
            <Choice
              value={settings.autoStart ? 'on' : 'off'}
              onChange={(value) => saveSettings({ autoStart: value === 'on' })}
              options={[
                { value: 'on', label: 'Offer mirroring' },
                { value: 'off', label: 'Do nothing' },
              ]}
            />
            <Body dim>
              When this Bluetooth device connects, the app looks for the dash and brings up Start Broadcast. If the
              app is in the background you get a notification instead. iOS requires your tap to start mirroring, and
              the app must already be open in the background.
            </Body>
            <Button label="Forget this Bluetooth device" kind="plain" onPress={() => setBikeBluetooth(null)} />
          </>
        ) : (
          <Body dim>
            Connect the phone to the bike over Bluetooth, then come back here and choose it. The app will then offer
            mirroring each time the bike connects.
          </Body>
        )}
        {candidate ? (
          <Button
            label={`Use "${candidate}" as my bike`}
            kind={settings.bikeBluetooth ? 'plain' : 'primary'}
            onPress={() => setBikeBluetooth(candidate)}
          />
        ) : !settings.bikeBluetooth ? (
          <Body dim>No Bluetooth audio device is connected right now.</Body>
        ) : null}
      </Card>

      <Card title="Spotify on the dash">
        {spotify.connected ? (
          <>
            <Body>Connected. The Music page on the dash shows what Spotify is playing.</Body>
            {spotify.playback ? (
              <Row label="Now" value={`${spotify.playback.title} · ${spotify.playback.artist}`} />
            ) : null}
            <Button label="Disconnect Spotify" kind="plain" onPress={() => void disconnectSpotify()} />
          </>
        ) : (
          <>
            <Body dim>
              iOS does not let one app see what another is playing, so the Music page asks Spotify directly. That
              needs your own free Spotify developer app, set up once:
            </Body>
            <Body dim>1. Open developer.spotify.com, sign in, Create app.</Body>
            <Body dim selectable>
              2. Redirect URI: {REDIRECT_URI}
            </Body>
            <Body dim>3. Tick Web API, save, then copy the Client ID here.</Body>
            <TextInput
              value={clientId}
              onChangeText={setClientId}
              onEndEditing={() => setSpotifyClientId(clientId)}
              placeholder="Client ID"
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              accessibilityLabel="Spotify client ID"
            />
            <Button
              label="Connect Spotify"
              disabled={clientId.trim().length === 0}
              onPress={() => {
                setSpotifyClientId(clientId);
                void connectSpotify();
              }}
            />
          </>
        )}
        {spotify.error ? <Text style={styles.error}>{spotify.error}</Text> : null}
        <Body dim>
          Play, pause and skip need Spotify Premium. The page needs mobile data. YouTube Music offers no way to do
          this; mirror its screen instead.
        </Body>
      </Card>

      <Card title="Dash picture">
        <Body dim>Colours, after the CFMOTO liveries.</Body>
        <Choice
          value={theme}
          onChange={setDashTheme}
          options={THEMES.map((value) => ({ value, label: THEME_LABELS[value] }))}
        />
        <Body dim>Units.</Body>
        <Choice
          value={settings.units}
          onChange={(units) => saveSettings({ units })}
          options={[
            { value: 'metric', label: 'km/h' },
            { value: 'imperial', label: 'mph' },
          ]}
        />
        <Body dim>
          Picture quality. Lower it if helmet audio stutters: the dash Wi-Fi and Bluetooth share the same radio band.
        </Body>
        <Choice
          value={settings.bitrateKbps}
          onChange={(bitrateKbps) => saveSettings({ bitrateKbps })}
          options={[
            { value: 800, label: 'Low' },
            { value: 1500, label: 'Balanced' },
            { value: 2500, label: 'High' },
          ]}
        />
      </Card>

      <Card title="If the dash will not connect">
        <Body dim>
          These change how the app introduces itself to the dash. They take effect on the next Connect. The defaults
          match what is known to work on CFMOTO dashes.
        </Body>
        <Body dim>Phone type reported to the dash.</Body>
        <Choice
          value={settings.identityOs}
          onChange={(identityOs) => saveSettings({ identityOs })}
          options={[
            { value: 'Android', label: 'Android (default)' },
            { value: 'iOS', label: 'iOS' },
          ]}
        />
        <Body dim>Dash generation. Try the other one if it connects but the picture never appears.</Body>
        <Choice
          value={settings.supportFunction}
          onChange={(supportFunction) => saveSettings({ supportFunction })}
          options={[
            { value: 0, label: 'Older dash (default)' },
            { value: 128, label: 'Newer dash' },
          ]}
        />
      </Card>

      <Card title="Tips">
        <Body dim>Bring back the explanation cards you closed.</Body>
        <Button
          label="Show tips again"
          kind="plain"
          disabled={settings.dismissedHints.length === 0}
          onPress={restoreHints}
        />
      </Card>

      <Card title="Log">
        <Text style={styles.log} selectable>
          {logs.length === 0 ? 'Nothing logged yet.' : logs.slice(-80).join('\n')}
        </Text>
        <Button label="Clear log" kind="plain" disabled={logs.length === 0} onPress={() => setState({ logs: [] })} />
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
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  log: { color: colors.dim, fontSize: 12, lineHeight: 17, fontFamily: 'Menlo' },
});
