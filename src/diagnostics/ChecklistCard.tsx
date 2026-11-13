/** Roadside connection checklist. Presentational: everything comes in through props. */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '../i18n';
import { Body, Card, colors } from '../ui/kit';
import type { Checklist, ChecklistStep, StepStatus } from './checklist';

const STATUS: Record<StepStatus, { icon: string; color: string }> = {
  done: { icon: '✓', color: colors.ok },
  active: { icon: '…', color: colors.warn },
  waiting: { icon: '○', color: colors.dim },
  failed: { icon: '✕', color: colors.danger },
  skipped: { icon: '–', color: colors.dim },
};

function HintBlock({ step }: { step: ChecklistStep }) {
  const t = useT();
  if (!step.hint) return null;
  return (
    <View style={styles.hint}>
      <Text style={styles.hintHeading}>{t('checklist.likelyCauses')}</Text>
      {step.hint.causes.map((cause) => (
        <Text key={cause} style={styles.hintLine}>
          {'•  '}
          {cause}
        </Text>
      ))}
      <Text style={styles.hintHeading}>{t('checklist.whatToDo')}</Text>
      {step.hint.actions.map((action, index) => (
        <Text key={action} style={styles.hintLine}>
          {`${index + 1}.  `}
          {action}
        </Text>
      ))}
    </View>
  );
}

function StepRow({ step, open, onToggle }: { step: ChecklistStep; open: boolean; onToggle: () => void }) {
  const t = useT();
  const look = { ...STATUS[step.status], word: t(`checklist.status.${step.status}`) };
  const label = `${step.title}: ${look.word}. ${step.detail}`;
  const content = (
    <View style={styles.rowTop}>
      <View style={[styles.badge, { borderColor: look.color }]}>
        <Text style={[styles.icon, { color: look.color }]}>{look.icon}</Text>
      </View>
      <View style={styles.rowText}>
        <View style={styles.titleLine}>
          <Text style={[styles.title, step.status === 'waiting' && { color: colors.dim }]}>{step.title}</Text>
          <Text style={[styles.word, { color: look.color }]}>{look.word}</Text>
        </View>
        <Text style={styles.detail}>{step.detail}</Text>
      </View>
      {step.hint ? <Text style={styles.chevron}>{open ? '▾' : '›'}</Text> : null}
    </View>
  );

  if (!step.hint) {
    return (
      <View style={styles.row} accessible accessibilityLabel={label}>
        {content}
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={open ? t('checklist.hidesHint') : t('checklist.showsHint')}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [styles.pressable, pressed && { opacity: 0.6 }]}>
        {content}
      </Pressable>
      {open ? <HintBlock step={step} /> : null}
    </View>
  );
}

export function ChecklistCard(props: { checklist: Checklist; title?: string }) {
  const t = useT();
  // The stuck step starts open; the rider can fold it.
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const { steps, headline } = props.checklist;
  return (
    <Card title={props.title ?? t('checklist.defaultTitle')}>
      <Body>{headline}</Body>
      <View style={styles.list}>
        {steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            open={!closed[step.id]}
            onToggle={() => setClosed((prev) => ({ ...prev, [step.id]: !prev[step.id] }))}
          />
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { gap: 2 },
  row: { minHeight: 44, paddingVertical: 6, gap: 8 },
  pressable: { minHeight: 44, justifyContent: 'center' },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  icon: { fontSize: 15, fontWeight: '800' },
  rowText: { flex: 1, gap: 2 },
  titleLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  word: { fontSize: 14, fontWeight: '700' },
  detail: { color: colors.dim, fontSize: 15, lineHeight: 20 },
  chevron: { color: colors.dim, fontSize: 20, width: 20, textAlign: 'center', marginTop: 2 },
  hint: {
    marginLeft: 40,
    padding: 12,
    gap: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
  },
  hintHeading: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 2 },
  hintLine: { color: colors.text, fontSize: 15, lineHeight: 21 },
});
