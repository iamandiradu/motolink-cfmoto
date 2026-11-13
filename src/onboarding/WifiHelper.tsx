/**
 * Helps the rider join the dash Wi-Fi once in iOS Settings.
 * With a free Apple ID the app cannot join it by itself; iOS rejoins it afterwards.
 */
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Linking, StyleSheet, Text, View } from 'react-native';

import { useT } from '../i18n';
import { colors } from '../ui/kit';
import { Action, Status } from './ui';

export interface WifiHelperProps {
  ssid: string;
  password: string;
  /** True once the phone is on the dash network. */
  connected: boolean;
  /** Shown as a button once connected (or as "I have joined" before). Omit to hide it. */
  onDone?: () => void;
}

type Copied = 'name' | 'password' | null;

export function WifiHelper({ ssid, password, connected, onDone }: WifiHelperProps) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState<Copied>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasPassword = password.length > 0;

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  const copy = async (what: 'name' | 'password') => {
    try {
      await Clipboard.setStringAsync(what === 'name' ? ssid : password);
      setCopyFailed(false);
      setCopied(what);
      AccessibilityInfo.announceForAccessibility(what === 'name' ? t('wifi.announceName') : t('wifi.announcePassword'));
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setCopied(null), 4000);
    } catch {
      setCopied(null);
      setCopyFailed(true);
      AccessibilityInfo.announceForAccessibility(t('wifi.announceFailed'));
    }
  };

  const openSettings = () => {
    Linking.openSettings().catch(() => undefined);
  };

  const steps = [
    hasPassword ? t('wifi.stepCopy') : t('wifi.stepNoPassword'),
    t('wifi.stepOpen'),
    t('wifi.stepChoose', { ssid }),
    hasPassword ? t('wifi.stepPaste') : t('wifi.stepJoin'),
    t('wifi.stepBack'),
  ];

  return (
    <View style={styles.root}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{t('wifi.networkName')}</Text>
        <View style={styles.fieldRow}>
          <Text style={styles.value} selectable accessibilityLabel={t('wifi.networkNameA11y', { ssid })}>
            {ssid}
          </Text>
          <Action
            compact
            kind="plain"
            label={copied === 'name' ? t('wifi.copied') : t('wifi.copy')}
            accessibilityLabel={t('wifi.copyNameA11y')}
            onPress={() => copy('name')}
          />
        </View>
      </View>

      {hasPassword ? (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('wifi.password')}</Text>
          <View style={styles.fieldRow}>
            <Text
              style={[styles.value, !shown && styles.hidden]}
              selectable={shown}
              accessibilityLabel={shown ? t('wifi.passwordA11y', { password }) : t('wifi.passwordHidden')}>
              {shown ? password : '•'.repeat(Math.min(password.length, 16))}
            </Text>
            <Action
              compact
              kind="plain"
              label={shown ? t('wifi.hide') : t('wifi.show')}
              accessibilityLabel={shown ? t('wifi.hidePasswordA11y') : t('wifi.showPasswordA11y')}
              onPress={() => setShown(!shown)}
            />
            <Action
              compact
              kind="plain"
              label={copied === 'password' ? t('wifi.copied') : t('wifi.copy')}
              accessibilityLabel={t('wifi.copyPasswordA11y')}
              onPress={() => copy('password')}
            />
          </View>
        </View>
      ) : null}

      {copied ? <Status ok>{copied === 'name' ? t('wifi.statusName') : t('wifi.statusPassword')}</Status> : null}
      {copyFailed ? <Status ok={false}>{t('wifi.copyFailed')}</Status> : null}

      <View accessibilityRole="list" style={styles.steps}>
        {steps.map((text, i) => (
          <View key={i} style={styles.stepRow} accessible accessibilityLabel={t('wifi.stepA11y', { n: i + 1, text })}>
            <Text style={styles.stepNumber}>{i + 1}.</Text>
            <Text style={styles.stepText}>{text}</Text>
          </View>
        ))}
      </View>

      {connected ? (
        <Status ok>{t('wifi.connectedTo', { ssid })}</Status>
      ) : (
        <Action label={t('wifi.openSettings')} accessibilityHint={t('wifi.openSettingsHint')} onPress={openSettings} />
      )}

      <Text style={styles.note}>{t('wifi.note')}</Text>

      {onDone ? (
        <Action kind={connected ? 'primary' : 'plain'} label={connected ? t('wifi.done') : t('wifi.joined')} onPress={onDone} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 14 },
  field: { gap: 6, backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.line },
  fieldLabel: { color: colors.dim, fontSize: 15 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  value: { color: colors.text, fontSize: 18, fontWeight: '700', flex: 1, minWidth: 120 },
  hidden: { letterSpacing: 2 },
  steps: { gap: 8 },
  stepRow: { flexDirection: 'row', gap: 8 },
  stepNumber: { color: colors.accent, fontSize: 15, fontWeight: '700', width: 22, lineHeight: 21 },
  stepText: { color: colors.text, fontSize: 15, lineHeight: 21, flex: 1 },
  note: { color: colors.dim, fontSize: 15, lineHeight: 21 },
});
