/**
 * Helps the rider join the dash Wi-Fi once in iOS Settings.
 * With a free Apple ID the app cannot join it by itself; iOS rejoins it afterwards.
 */
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Linking, StyleSheet, Text, View } from 'react-native';

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
      AccessibilityInfo.announceForAccessibility(what === 'name' ? 'Network name copied' : 'Password copied');
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setCopied(null), 4000);
    } catch {
      setCopied(null);
      setCopyFailed(true);
      AccessibilityInfo.announceForAccessibility('Could not copy. Show the password and type it instead.');
    }
  };

  const openSettings = () => {
    Linking.openSettings().catch(() => undefined);
  };

  const steps = [
    hasPassword ? 'Copy the password.' : 'This network has no password.',
    'Tap Open Settings. iOS opens the MotoLink page, so tap Settings at the top left, then Wi-Fi.',
    `Choose ${ssid}.`,
    hasPassword ? 'Paste the password and tap Join.' : 'Tap Join if iOS asks.',
    'Come back to MotoLink.',
  ];

  return (
    <View style={styles.root}>
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Network name</Text>
        <View style={styles.fieldRow}>
          <Text style={styles.value} selectable accessibilityLabel={`Network name: ${ssid}`}>
            {ssid}
          </Text>
          <Action
            compact
            kind="plain"
            label={copied === 'name' ? 'Copied' : 'Copy'}
            accessibilityLabel="Copy network name"
            onPress={() => copy('name')}
          />
        </View>
      </View>

      {hasPassword ? (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Password</Text>
          <View style={styles.fieldRow}>
            <Text
              style={[styles.value, !shown && styles.hidden]}
              selectable={shown}
              accessibilityLabel={shown ? `Password: ${password}` : 'Password, hidden'}>
              {shown ? password : '•'.repeat(Math.min(password.length, 16))}
            </Text>
            <Action
              compact
              kind="plain"
              label={shown ? 'Hide' : 'Show'}
              accessibilityLabel={shown ? 'Hide password' : 'Show password'}
              onPress={() => setShown(!shown)}
            />
            <Action
              compact
              kind="plain"
              label={copied === 'password' ? 'Copied' : 'Copy'}
              accessibilityLabel="Copy password"
              onPress={() => copy('password')}
            />
          </View>
        </View>
      ) : null}

      {copied ? <Status ok>{copied === 'name' ? 'Network name copied.' : 'Password copied. Paste it in Settings.'}</Status> : null}
      {copyFailed ? <Status ok={false}>Could not copy. Tap Show and type the password instead.</Status> : null}

      <View accessibilityRole="list" style={styles.steps}>
        {steps.map((text, i) => (
          <View key={i} style={styles.stepRow} accessible accessibilityLabel={`Step ${i + 1}: ${text}`}>
            <Text style={styles.stepNumber}>{i + 1}.</Text>
            <Text style={styles.stepText}>{text}</Text>
          </View>
        ))}
      </View>

      {connected ? (
        <Status ok>Connected to {ssid}.</Status>
      ) : (
        <Action label="Open Settings" accessibilityHint="Opens the MotoLink page in iOS Settings" onPress={openSettings} />
      )}

      <Text style={styles.note}>You need to do this once. After that, iOS joins the dash Wi-Fi by itself.</Text>

      {onDone ? (
        <Action kind={connected ? 'primary' : 'plain'} label={connected ? 'Done' : 'I have joined'} onPress={onDone} />
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
