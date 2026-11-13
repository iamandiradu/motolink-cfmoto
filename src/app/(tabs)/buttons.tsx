import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { applyButtonMode } from '../../app-state/controller';
import { dismissHint, saveLayout, saveSettings, useAppState } from '../../app-state/store';
import { Gesture, RawButtonEvent, buttonGroups, gestureLabel } from '../../buttons/gestures';
import { ACTIONS, DEFAULT_LAYOUT, actionLabel, isDefaultLayout, setMapping } from '../../buttons/mapping';
import { TFunction, useT } from '../../i18n';
import { Body, Button, Card, Choice, Hint, Screen, colors } from '../../ui/kit';

const HINT_ID = 'buttons-intro';

/**
 * What the phone received, worded to sit inside a sentence. Each language
 * writes it in the right case itself (German nouns keep their capital), so
 * the caller no longer lower-cases it.
 */
function describeRaw(t: TFunction, raw: RawButtonEvent): string {
  if (raw.type === 'volume') {
    const pct = Math.round(Math.abs(raw.delta) * 100);
    return raw.delta > 0 ? t('buttons.rawVolumeUp', { pct }) : t('buttons.rawVolumeDown', { pct });
  }
  return { playPause: t('buttons.rawPlayPause'), next: t('buttons.rawNext'), previous: t('buttons.rawPrevious') }[raw.key];
}

export default function ButtonsScreen() {
  const t = useT();
  const layout = useAppState((s) => s.layout);
  const settings = useAppState((s) => s.settings);
  const last = useAppState((s) => s.lastButton);
  const [editing, setEditing] = useState<Gesture | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const showHint = !settings.dismissedHints.includes(HINT_ID);
  const captureOff = settings.buttonMode === 'off';

  return (
    <Screen>
      {showHint ? (
        <Hint title={t('buttons.hintTitle')} onDismiss={() => dismissHint(HINT_ID)}>
          <Body dim>{t('buttons.hint1')}</Body>
          <Body dim>{t('buttons.hint2')}</Body>
          <Body dim>{t('buttons.hint3')}</Body>
          <Body dim>{t('buttons.hint4')}</Body>
        </Hint>
      ) : null}

      <Card title={t('buttons.listenTo')}>
        <Choice
          value={settings.buttonMode}
          onChange={(buttonMode) => {
            saveSettings({ buttonMode });
            void applyButtonMode();
          }}
          options={[
            { value: 'off', label: t('buttons.listenNothing') },
            { value: 'volume', label: t('buttons.listenVolume') },
            { value: 'full', label: t('buttons.listenAll') },
          ]}
        />
        <Body dim>{t(`buttons.mode.${settings.buttonMode}`)}</Body>
      </Card>

      <Card title={t('buttons.lastPress')}>
        {captureOff ? (
          <Body dim>{t('buttons.captureOff')}</Body>
        ) : last ? (
          <>
            <Text style={styles.lastGesture}>
              {last.gesture ? gestureLabel(last.gesture) : t('buttons.notRecognised')}
            </Text>
            <Body dim>
              {last.gesture ? t('buttons.does', { action: actionLabel(layout[last.gesture]) }) : ''}
              {t('buttons.phoneReceived', { raw: describeRaw(t, last.raw) })}
            </Body>
          </>
        ) : (
          <Body dim>{t('buttons.nothingYet')}</Body>
        )}
      </Card>

      <Card title={t('buttons.whatEach')}>
        {buttonGroups().map((group) => (
          <View key={group.id} style={styles.group}>
            <Text style={styles.groupTitle}>{group.button}</Text>
            {group.gestures.map(({ gesture, label }) => {
              const open = editing === gesture;
              const changed = layout[gesture] !== DEFAULT_LAYOUT[gesture];
              return (
                <View key={gesture}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('buttons.rowA11y', { button: group.button, gesture: label, action: actionLabel(layout[gesture]) })}
                    accessibilityState={{ expanded: open }}
                    onPress={() => setEditing(open ? null : gesture)}
                    style={styles.row}>
                    <Text style={styles.rowLabel}>{label}</Text>
                    <Text style={[styles.rowAction, changed && { color: colors.accent }]}>
                      {actionLabel(layout[gesture])}
                    </Text>
                    <Text style={styles.chevron}>{open ? '▾' : '›'}</Text>
                  </Pressable>
                  {open ? (
                    <View style={styles.options}>
                      {ACTIONS.map((action) => {
                        const selected = layout[gesture] === action;
                        return (
                          <Pressable
                            key={action}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            onPress={() => {
                              saveLayout(setMapping(layout, gesture, action));
                              setEditing(null);
                            }}
                            style={styles.option}>
                            <Text style={[styles.optionMark, selected && { color: colors.accent }]}>
                              {selected ? '●' : '○'}
                            </Text>
                            <Text style={[styles.optionLabel, selected && { color: colors.accent }]}>
                              {actionLabel(action)}
                              {action === DEFAULT_LAYOUT[gesture] ? t('buttons.isDefault') : ''}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
        <Button
          label={t('buttons.restore')}
          kind="plain"
          disabled={isDefaultLayout(layout)}
          onPress={() => {
            saveLayout({ ...DEFAULT_LAYOUT });
            setEditing(null);
          }}
        />
        <Body dim>{t('buttons.holdNote')}</Body>
      </Card>

      <Card>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: advanced }}
          onPress={() => setAdvanced(!advanced)}
          style={styles.row}>
          <Text style={styles.advancedTitle}>{t('buttons.advanced')}</Text>
          <Text style={styles.chevron}>{advanced ? '▾' : '›'}</Text>
        </Pressable>
        {advanced ? (
          <>
            <Body dim>{t('buttons.advancedBody')}</Body>
            <Choice
              value={settings.pinVolume ? 'on' : 'off'}
              onChange={(value) => {
                saveSettings({ pinVolume: value === 'on' });
                void applyButtonMode();
              }}
              options={[
                { value: 'on', label: t('buttons.pinOn') },
                { value: 'off', label: t('buttons.pinOff') },
              ]}
            />
          </>
        ) : null}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lastGesture: { color: colors.text, fontSize: 20, fontWeight: '700' },
  group: { gap: 0 },
  groupTitle: {
    color: colors.dim,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 6,
  },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowLabel: { color: colors.text, fontSize: 16, flex: 1 },
  rowAction: { color: colors.dim, fontSize: 16, fontWeight: '600' },
  chevron: { color: colors.dim, fontSize: 18, width: 16, textAlign: 'center' },
  options: { paddingVertical: 4, paddingLeft: 8 },
  option: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
  optionMark: { color: colors.dim, fontSize: 14, width: 18 },
  optionLabel: { color: colors.text, fontSize: 16 },
  advancedTitle: { color: colors.text, fontSize: 17, fontWeight: '700', flex: 1 },
});
