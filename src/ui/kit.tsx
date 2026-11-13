/** Shared pieces for the phone screens. */
import { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export const colors = {
  bg: '#0b0f14',
  card: '#151b23',
  line: '#26303b',
  text: '#eef2f6',
  dim: '#8b98a5',
  accent: '#19c2d1',
  onAccent: '#04262a',
  danger: '#ff6b5e',
  ok: '#3ddc84',
  warn: '#ffb020',
};

export function Screen({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      {children}
    </ScrollView>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Body({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return <Text style={[styles.body, dim && { color: colors.dim }]}>{children}</Text>;
}

export function Button(props: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'plain' | 'danger';
  disabled?: boolean;
}) {
  const kind = props.kind ?? 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && { backgroundColor: colors.accent },
        kind !== 'primary' && { borderWidth: 1, borderColor: kind === 'danger' ? colors.danger : colors.line },
        (pressed || props.disabled) && { opacity: 0.5 },
      ]}>
      <Text
        style={[
          styles.buttonLabel,
          { color: kind === 'primary' ? colors.onAccent : kind === 'danger' ? colors.danger : colors.text },
        ]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** One row of mutually exclusive choices. */
export function Choice<T extends string | number>(props: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.choice}>
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => props.onChange(option.value)}
            style={[styles.choiceItem, selected && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
            <Text style={[styles.choiceLabel, selected && { color: colors.onAccent }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  screenContent: { padding: 16, gap: 14, paddingBottom: 40 },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 16, gap: 10 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  button: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonLabel: { fontSize: 16, fontWeight: '700' },
  choice: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceItem: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  rowLabel: { color: colors.dim, fontSize: 15 },
  rowValue: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
