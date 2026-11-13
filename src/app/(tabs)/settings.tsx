import { StyleSheet, Text } from 'react-native';

import { dispatchDashAction } from '../../app-state/controller';
import { saveSettings, setState, useAppState } from '../../app-state/store';
import { Body, Button, Card, Choice, Screen, colors } from '../../ui/kit';

export default function SettingsScreen() {
  const settings = useAppState((s) => s.settings);
  const theme = useAppState((s) => s.dash.theme);
  const logs = useAppState((s) => s.logs);

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

      <Card title="Dash picture">
        <Body dim>Day or night colours.</Body>
        <Choice
          value={theme}
          onChange={(value) => value !== theme && dispatchDashAction('toggleTheme')}
          options={[
            { value: 'night', label: 'Night' },
            { value: 'day', label: 'Day' },
          ]}
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
  log: { color: colors.dim, fontSize: 12, lineHeight: 17, fontFamily: 'Menlo' },
});
