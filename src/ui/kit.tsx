/** Shared pieces for the phone screens. */
import { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

export const colors = {
  bg: '#000000',
  card: '#12161c',
  line: '#2a323c',
  text: '#f2f5f8',
  dim: '#93a1b0',
  /** CFMOTO blue. */
  accent: '#00aeef',
  onAccent: '#001a26',
  /** CFMOTO pink: destructive actions and errors. */
  danger: '#ff3d97',
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

/** An explanation the reader can close for good. */
export function Hint(props: { title: string; children: ReactNode; onDismiss: () => void }) {
  return (
    <View style={[styles.card, styles.hint]}>
      <View style={styles.hintHeader}>
        <Text style={styles.cardTitle}>{props.title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Dismiss: ${props.title}`}
          hitSlop={12}
          onPress={props.onDismiss}
          style={styles.hintClose}>
          <Text style={styles.hintCloseGlyph}>✕</Text>
        </Pressable>
      </View>
      {props.children}
    </View>
  );
}

export function Body({ children, dim, selectable }: { children: ReactNode; dim?: boolean; selectable?: boolean }) {
  return (
    <Text selectable={selectable} style={[styles.body, dim && { color: colors.dim }]}>
      {children}
    </Text>
  );
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

/** A number changed in fixed steps with two large buttons. */
export function Stepper(props: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const set = (next: number) => props.onChange(Math.min(props.max, Math.max(props.min, next)));
  const button = (glyph: string, name: string, next: number, disabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name} ${props.label}`}
      disabled={disabled}
      onPress={() => set(next)}
      style={[styles.stepButton, disabled && { opacity: 0.35 }]}>
      <Text style={styles.stepGlyph}>{glyph}</Text>
    </Pressable>
  );
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepLabel}>{props.label}</Text>
      {button('−', 'Decrease', props.value - props.step, props.value <= props.min)}
      <Text style={styles.stepValue}>
        {props.value}
        {props.unit}
      </Text>
      {button('+', 'Increase', props.value + props.step, props.value >= props.max)}
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
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '700', flexShrink: 1 },
  hint: { borderWidth: 1, borderColor: colors.line },
  hintHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  hintClose: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.line },
  hintCloseGlyph: { color: colors.text, fontSize: 15, fontWeight: '700' },
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
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
  stepLabel: { color: colors.text, fontSize: 16, flex: 1 },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyph: { color: colors.text, fontSize: 22, fontWeight: '600' },
  stepValue: { color: colors.text, fontSize: 16, fontWeight: '700', width: 64, textAlign: 'center', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  rowLabel: { color: colors.dim, fontSize: 15 },
  rowValue: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
