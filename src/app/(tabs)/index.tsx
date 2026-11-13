import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { connect, disconnect } from '../../app-state/controller';
import { saveBike, useAppState } from '../../app-state/store';
import { parsePairingQr } from '../../protocol/qr';
import type { LinkState } from '../../protocol/session';
import { Body, Button, Card, Row, Screen, colors } from '../../ui/kit';

const STATE_TEXT: Record<LinkState, { title: string; hint: string; color: string }> = {
  idle: { title: 'Not connected', hint: 'Tap Connect with the bike switched on.', color: colors.dim },
  searching: {
    title: 'Looking for the bike',
    hint: 'Switch the ignition on and open MotoPlay on the dash. The phone joins the dash Wi-Fi by itself.',
    color: colors.warn,
  },
  probing: { title: 'Bike found, asking to connect', hint: 'On the dash Wi-Fi. Waiting for the dash to answer.', color: colors.warn },
  waitingForDash: { title: 'Dash accepted', hint: 'Waiting for the dash to call back.', color: colors.warn },
  handshaking: { title: 'Connecting', hint: 'Exchanging details with the dash.', color: colors.warn },
  negotiated: { title: 'Connected', hint: 'Picture size agreed. Waiting for the dash to show it.', color: colors.ok },
  streaming: { title: 'On the dash', hint: 'The dash is showing the picture above.', color: colors.ok },
};

export default function LinkScreen() {
  const bike = useAppState((s) => s.bike);
  const link = useAppState((s) => s.link);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const status = STATE_TEXT[link.state];
  const active = link.state !== 'idle';

  const pairFromText = () => {
    const parsed = parsePairingQr(manual);
    if (!parsed) {
      setManualError('That text has no Wi-Fi name and password. Paste the full link from the QR code.');
      return;
    }
    setManualError(null);
    setManual('');
    saveBike(parsed);
    connect();
  };

  if (!bike) {
    return (
      <Screen>
        <Card title="Pair with your bike">
          <Body>
            Switch the ignition on, open MotoPlay on the dash and choose the phone connection screen. The dash shows a
            QR code. Scan it once; after that the app connects by itself.
          </Body>
          <Button label="Scan the dash QR" onPress={() => router.push('/scan')} />
        </Card>
        <Card title="Or paste the QR link">
          <TextInput
            value={manual}
            onChangeText={setManual}
            placeholder="http://…?ssid=CFMOTO-…&pwd=…"
            placeholderTextColor={colors.dim}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel="QR link"
          />
          {manualError ? <Text style={styles.error}>{manualError}</Text> : null}
          <Button label="Pair" kind="plain" onPress={pairFromText} disabled={manual.trim().length === 0} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: status.color }]} />
          <Text style={styles.statusTitle}>{status.title}</Text>
        </View>
        <Body dim>{status.hint}</Body>
        {link.lastError && active && link.state !== 'streaming' ? <Text style={styles.error}>{link.lastError}</Text> : null}
        {active ? (
          <Button label="Disconnect" kind="plain" onPress={() => void disconnect()} />
        ) : (
          <Button label="Connect" onPress={connect} />
        )}
      </Card>

      <Card title="Bike">
        <Row label="Wi-Fi" value={bike.ssid} />
        {link.dash?.name ? <Row label="Dash" value={link.dash.name} /> : null}
        {link.dash?.sdkVersion ? <Row label="Dash software" value={link.dash.sdkVersion} /> : null}
        {link.capture ? (
          <Row label="Picture" value={`${link.capture.width} × ${link.capture.height}`} />
        ) : null}
        {link.state === 'streaming' ? (
          <Row label="Frames sent / dropped" value={`${link.framesSent} / ${link.framesDropped}`} />
        ) : null}
        <Button
          label="Forget this bike"
          kind="danger"
          onPress={() => {
            void disconnect();
            saveBike(null);
          }}
        />
      </Card>

      <Card title="Before you ride">
        <Body dim>
          Close the CFMOTO app: it uses the same connection and the dash will talk to it instead. Keep this app open
          on screen while riding; iOS stops the picture when the app is in the background.
        </Body>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  statusTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
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
});
