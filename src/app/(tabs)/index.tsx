import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { applyMirrorView, connect, disconnect, toggleMirroring } from '../../app-state/controller';
import { DEFAULT_MIRROR_VIEW, MirrorView, dismissHint, saveBike, saveSettings, useAppState } from '../../app-state/store';
import { parsePairingQr } from '../../protocol/qr';
import type { LinkState } from '../../protocol/session';
import { Body, Button, Card, Choice, Hint, Row, Screen, Stepper, colors } from '../../ui/kit';

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

const NAV_APPS = [
  { label: 'Apple Maps', url: 'maps://' },
  { label: 'Google Maps', url: 'comgooglemaps://' },
  { label: 'Waze', url: 'waze://' },
] as const;

const FIT_TEXT: Record<MirrorView['fit'], string> = {
  auto: 'A sideways phone fills the dash. An upright phone is shown whole, with bars at the sides.',
  fill: 'Always fills the dash. The edges that do not fit are cut off.',
  fit: 'Always shows the whole screen. Bars appear where it does not reach.',
};

/** Crop, zoom and fit of the mirrored picture. Changes apply while mirroring. */
function MirrorAdjust() {
  const view = useAppState((s) => s.settings.mirrorView);
  const [open, setOpen] = useState(false);
  const changed = (Object.keys(DEFAULT_MIRROR_VIEW) as (keyof MirrorView)[]).some(
    (key) => view[key] !== DEFAULT_MIRROR_VIEW[key],
  );

  const update = (patch: Partial<MirrorView>) => {
    saveSettings({ mirrorView: { ...view, ...patch } });
    applyMirrorView();
  };
  const trim = (label: string, key: 'trimTop' | 'trimBottom' | 'trimLeft' | 'trimRight') => (
    <Stepper label={label} value={view[key]} unit="%" min={0} max={40} step={2} onChange={(value) => update({ [key]: value })} />
  );

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.adjustHeader}>
        <Text style={styles.adjustTitle}>Adjust the picture{changed ? ' (changed)' : ''}</Text>
        <Text style={styles.adjustChevron}>{open ? '▾' : '›'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.adjustBody}>
          <Choice
            value={view.fit}
            onChange={(fit) => update({ fit })}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'fill', label: 'Fill' },
              { value: 'fit', label: 'Whole screen' },
            ]}
          />
          <Body dim>{FIT_TEXT[view.fit]}</Body>
          <Stepper label="Zoom" value={view.zoom} unit="%" min={100} max={250} step={10} onChange={(zoom) => update({ zoom })} />
          <Body dim>Cut edges, to hide the status bar or an app&apos;s buttons. Sides are those of the picture as you see it.</Body>
          {trim('Cut top', 'trimTop')}
          {trim('Cut bottom', 'trimBottom')}
          {trim('Cut left', 'trimLeft')}
          {trim('Cut right', 'trimRight')}
          <Button
            label="Reset picture"
            kind="plain"
            disabled={!changed}
            onPress={() => {
              saveSettings({ mirrorView: DEFAULT_MIRROR_VIEW });
              applyMirrorView();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function MirrorCard({ mirroring }: { mirroring: boolean }) {
  const [missing, setMissing] = useState<string | null>(null);

  const open = (app: (typeof NAV_APPS)[number]) => {
    setMissing(null);
    Linking.openURL(app.url).catch(() => setMissing(app.label));
  };

  return (
    <Card title="Show the phone screen on the dash">
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: mirroring ? colors.ok : colors.dim }]} />
        <Text style={styles.statusTitle}>{mirroring ? 'Mirroring is on' : 'Mirroring is off'}</Text>
      </View>
      <Body dim>
        {mirroring
          ? 'The dash shows whatever is on this phone. Open a navigation app and turn the phone sideways so the map fills the dash.'
          : 'Works with any app: Apple Maps, Google Maps, Waze, Spotify. Tap Start, choose MotoLink, then Start Broadcast.'}
      </Body>
      <Button
        label={mirroring ? 'Stop mirroring' : 'Start mirroring'}
        kind={mirroring ? 'plain' : 'primary'}
        onPress={toggleMirroring}
      />
      {mirroring ? (
        <>
          <View style={styles.apps}>
            {NAV_APPS.map((app) => (
              <View key={app.label} style={styles.app}>
                <Button label={app.label} kind="plain" onPress={() => open(app)} />
              </View>
            ))}
          </View>
          {missing ? <Text style={styles.error}>{missing} is not installed on this phone.</Text> : null}
        </>
      ) : null}
      <MirrorAdjust />
    </Card>
  );
}

export default function LinkScreen() {
  const bike = useAppState((s) => s.bike);
  const link = useAppState((s) => s.link);
  const mirroring = useAppState((s) => s.mirroring);
  const showRideHint = useAppState((s) => !s.settings.dismissedHints.includes('before-ride'));
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
        <MirrorCard mirroring={mirroring} />
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

      <MirrorCard mirroring={mirroring} />

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

      {showRideHint ? (
        <Hint title="Before you ride" onDismiss={() => dismissHint('before-ride')}>
          <Body dim>Close the CFMOTO app. It uses the same connection, and the dash would talk to it instead.</Body>
          <Body dim>Keep the phone screen on. Mirroring works with another app in front, but not with the phone locked.</Body>
          <Body dim>Set your route before moving. The handlebar buttons cannot steer other apps.</Body>
        </Hint>
      ) : null}
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
  apps: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  adjustHeader: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  adjustTitle: { color: colors.text, fontSize: 16, fontWeight: '600', flex: 1 },
  adjustChevron: { color: colors.dim, fontSize: 18, width: 16, textAlign: 'center' },
  adjustBody: { gap: 10 },
  app: { flexGrow: 1 },
});
