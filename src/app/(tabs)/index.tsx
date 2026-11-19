import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  changeMirrorPreset,
  connect,
  disconnect,
  selectMirrorPreset,
  setMirrorStrip,
  toggleMirroring,
} from '../../app-state/controller';
import { dismissHint, saveBike, saveSettings, useAppState } from '../../app-state/store';
import { DEFAULT_MIRROR_VIEW, MirrorView, PresetApp, isDefaultView, presetApps } from '../../mirror/presets';
import { MotoLink } from '../../../modules/moto-link';
import { ChecklistCard } from '../../diagnostics/ChecklistCard';
import { buildChecklist } from '../../diagnostics/checklist';
import { WifiHelper } from '../../onboarding/WifiHelper';
import { parsePairingQr } from '../../protocol/qr';
import type { LinkState } from '../../protocol/session';
import { TFunction, useT } from '../../i18n';
import { Body, Button, Card, Choice, Hint, Row, Screen, Stepper, colors, confirm } from '../../ui/kit';

const STATE_COLOR: Record<LinkState, string> = {
  idle: colors.dim,
  searching: colors.warn,
  probing: colors.warn,
  waitingForDash: colors.warn,
  handshaking: colors.warn,
  negotiated: colors.ok,
  streaming: colors.ok,
};

/** Read at render time, so the texts follow the app language. */
function stateText(t: TFunction, state: LinkState): { title: string; hint: string; color: string } {
  return { title: t(`link.state.${state}.title`), hint: t(`link.state.${state}.hint`), color: STATE_COLOR[state] };
}

/** Crop, zoom and fit of the mirrored picture, kept separately for each app. */
function MirrorAdjust() {
  const t = useT();
  const presetList = presetApps(Platform.OS);
  const presets = useAppState((s) => s.settings.mirrorPresets);
  const active = useAppState((s) => s.settings.mirrorPreset);
  const strip = useAppState((s) => s.settings.mirrorStrip);
  const [open, setOpen] = useState(false);
  const view = presets[active];
  const changed = !isDefaultView(view);
  const activeLabel = presetList.find((app) => app.id === active)?.label ?? '';

  const update = (patch: Partial<MirrorView>) => changeMirrorPreset(active, patch);
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
        <Text style={styles.adjustTitle}>
          {t('link.adjustTitle', { app: activeLabel })}
          {changed ? t('link.changed') : ''}
        </Text>
        <Text style={styles.adjustChevron}>{open ? '▾' : '›'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.adjustBody}>
          <Body dim>{t('link.stripBody')}</Body>
          <Choice
            value={strip}
            onChange={setMirrorStrip}
            options={[
              { value: 'bottom', label: t('link.stripBottom') },
              { value: 'top', label: t('link.stripTop') },
              { value: 'off', label: t('link.stripOff') },
            ]}
          />
          <Body dim>{t('link.presetsBody')}</Body>
          <Choice
            value={active}
            onChange={selectMirrorPreset}
            options={presetList.map((app) => ({ value: app.id, label: app.label }))}
          />
          <Choice
            value={view.fit}
            onChange={(fit) => update({ fit })}
            options={[
              { value: 'auto', label: t('link.fitAuto') },
              { value: 'fill', label: t('link.fitFill') },
              { value: 'fit', label: t('link.fitWhole') },
            ]}
          />
          <Body dim>{t(`link.fitText.${view.fit}`)}</Body>
          <Stepper label={t('link.zoom')} value={view.zoom} unit="%" min={100} max={250} step={10} onChange={(zoom) => update({ zoom })} />
          <Body dim>{t('link.trimBody')}</Body>
          {trim(t('link.cutTop'), 'trimTop')}
          {trim(t('link.cutBottom'), 'trimBottom')}
          {trim(t('link.cutLeft'), 'trimLeft')}
          {trim(t('link.cutRight'), 'trimRight')}
          <Button
            label={t('link.reset', { app: activeLabel })}
            kind="plain"
            disabled={!changed}
            onPress={() => update(DEFAULT_MIRROR_VIEW)}
          />
        </View>
      ) : null}
    </View>
  );
}

function MirrorCard({ mirroring }: { mirroring: boolean }) {
  const t = useT();
  const [missing, setMissing] = useState<string | null>(null);

  // Opening an app from here also switches to that app's picture settings.
  const open = (app: PresetApp) => {
    if (!app.url) return;
    setMissing(null);
    selectMirrorPreset(app.id);
    Linking.openURL(app.url).catch(() => setMissing(app.label));
  };

  return (
    <Card title={t('link.mirrorTitle')}>
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: mirroring ? colors.ok : colors.dim }]} />
        <Text style={styles.statusTitle}>{mirroring ? t('link.mirroringOn') : t('link.mirroringOff')}</Text>
      </View>
      <Body dim>
        {mirroring ? t('link.mirroringOnBody') : t('link.mirroringOffBody')}
      </Body>
      <Button
        label={mirroring ? t('link.stopMirroring') : t('link.startMirroring')}
        kind={mirroring ? 'plain' : 'primary'}
        onPress={toggleMirroring}
      />
      {mirroring ? (
        <>
          <View style={styles.apps}>
            {presetApps(Platform.OS).filter((app) => app.url).map((app) => (
              <View key={app.id} style={styles.app}>
                <Button label={app.label} kind="plain" onPress={() => open(app)} />
              </View>
            ))}
          </View>
          {missing ? <Text style={styles.error}>{t('link.notInstalled', { app: missing })}</Text> : null}
        </>
      ) : null}
      <MirrorAdjust />
    </Card>
  );
}

export default function LinkScreen() {
  const t = useT();
  const bike = useAppState((s) => s.bike);
  const link = useAppState((s) => s.link);
  const mirroring = useAppState((s) => s.mirroring);
  const logs = useAppState((s) => s.logs);
  const phoneType = useAppState((s) => s.settings.identityOs);
  const showRideHint = useAppState((s) => !s.settings.dismissedHints.includes('before-ride'));
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const status = stateText(t, link.state);
  const active = link.state !== 'idle';

  const pairFromText = () => {
    const parsed = parsePairingQr(manual);
    if (!parsed) {
      setManualError(t('link.manualError'));
      return;
    }
    setManualError(null);
    // Testing aid: a pasted link may carry `simhost=<address>` to point the app at the dash simulator.
    const simHost = /[?&]simhost=([^&#]+)/.exec(manual)?.[1];
    if (simHost) saveSettings({ dashHostOverride: decodeURIComponent(simHost) });
    setManual('');
    saveBike(parsed);
    connect();
  };

  if (!bike) {
    return (
      <Screen>
        <Card title={t('link.pairTitle')}>
          <Body>{t('link.pairBody')}</Body>
          <Button label={t('link.scanQr')} onPress={() => router.push('/scan')} />
        </Card>
        <Card title={t('link.pasteTitle')}>
          <TextInput
            value={manual}
            onChangeText={setManual}
            placeholder="http://…?ssid=CFMOTO-…&pwd=…"
            placeholderTextColor={colors.dim}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel={t('link.qrLinkA11y')}
            returnKeyType="go"
            onSubmitEditing={pairFromText}
          />
          {manualError ? <Text style={styles.error}>{manualError}</Text> : null}
          <Button label={t('link.pair')} kind="plain" onPress={pairFromText} disabled={manual.trim().length === 0} />
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
          <Button label={t('link.disconnect')} kind="plain" onPress={() => void disconnect()} />
        ) : (
          <Button label={t('link.connect')} onPress={connect} />
        )}
      </Card>

      {/* While connecting: where it has got to, and what to do if it is stuck. */}
      {active && link.state !== 'streaming' ? (
        <ChecklistCard
          title={t('link.connectionSteps')}
          checklist={(() => {
            const network = MotoLink.getNetworkInfo();
            return buildChecklist({
              paired: true,
              phoneIp: network.ip ?? null,
              dashAddress: network.gateway ?? null,
              snapshot: link,
              mirroring,
              logs,
              now: Date.now(),
              phoneType,
            });
          })()}
        />
      ) : null}

      {/* The phone is not on the dash network: show how to join it by hand. */}
      {link.state === 'searching' ? (
        <Card title={t('link.joinWifi')}>
          <WifiHelper ssid={bike.ssid} password={bike.password} connected={false} />
        </Card>
      ) : null}

      <MirrorCard mirroring={mirroring} />

      <Card title={t('link.bike')}>
        <Row label={t('link.wifi')} value={bike.ssid} />
        {link.dash?.name ? <Row label={t('link.dash')} value={link.dash.name} /> : null}
        {link.dash?.sdkVersion ? <Row label={t('link.dashSoftware')} value={link.dash.sdkVersion} /> : null}
        {link.capture ? (
          <Row label={t('link.picture')} value={`${link.capture.width} × ${link.capture.height}`} />
        ) : null}
        {link.state === 'streaming' ? (
          <Row label={t('link.frames')} value={`${link.framesSent} / ${link.framesDropped}`} />
        ) : null}
        <Button
          label={t('link.forget')}
          kind="danger"
          onPress={() =>
            confirm(t('link.forgetTitle'), t('link.forgetBody'), t('link.forgetAction'), () => {
              void disconnect();
              saveBike(null);
            })
          }
        />
      </Card>

      {showRideHint ? (
        <Hint title={t('link.beforeRideTitle')} onDismiss={() => dismissHint('before-ride')}>
          <Body dim>{t('link.beforeRide1')}</Body>
          <Body dim>{t('link.beforeRide2')}</Body>
          <Body dim>{t('link.beforeRide3')}</Body>
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
