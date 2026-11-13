/** Small controls shared by the onboarding screens. */
import { ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../ui/kit';

export type ActionKind = 'primary' | 'plain' | 'quiet';

/**
 * A button with a visible pressed and focused state (not opacity alone),
 * at least 48 pt tall.
 */
export function Action(props: {
  label: string;
  onPress: () => void;
  kind?: ActionKind;
  /** Spoken instead of the visible label, when the label alone is unclear. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  compact?: boolean;
  testID?: string;
}) {
  const kind = props.kind ?? 'primary';
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      testID={props.testID}
      onPress={props.onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      hitSlop={props.compact ? 6 : undefined}
      style={({ pressed }) => [
        styles.action,
        props.compact && styles.compact,
        kind === 'primary' && styles.primary,
        kind === 'plain' && styles.plain,
        kind === 'quiet' && styles.quiet,
        pressed && (kind === 'primary' ? styles.primaryPressed : styles.otherPressed),
        focused && styles.focused,
      ]}>
      {({ pressed }) => (
        <Text
          style={[
            styles.label,
            { color: kind === 'primary' ? colors.onAccent : kind === 'quiet' ? colors.accent : colors.text },
            pressed && kind !== 'primary' && styles.labelPressed,
          ]}>
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

/** A status line that pairs a symbol and words with the colour, so state never rests on colour alone. */
export function Status(props: { ok: boolean; children: ReactNode }) {
  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      style={[styles.status, { borderColor: props.ok ? colors.ok : colors.warn }]}>
      <Text style={[styles.statusGlyph, { color: props.ok ? colors.ok : colors.warn }]} accessibilityElementsHidden importantForAccessibility="no">
        {props.ok ? '✓' : '!'}
      </Text>
      <Text style={styles.statusText}>{props.children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  compact: { minHeight: 44, paddingHorizontal: 14 },
  primary: { backgroundColor: colors.accent },
  primaryPressed: { backgroundColor: '#0088bb' },
  plain: { borderColor: colors.line },
  quiet: {},
  otherPressed: { backgroundColor: colors.line },
  focused: { borderColor: colors.text },
  label: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
  labelPressed: { color: colors.text },
  status: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.card,
  },
  statusGlyph: { fontSize: 17, fontWeight: '800', lineHeight: 21 },
  statusText: { color: colors.text, fontSize: 15, lineHeight: 21, flex: 1 },
});
