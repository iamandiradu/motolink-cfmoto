import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { applyButtonMode } from '../../app-state/controller';
import { dismissHint, saveLayout, saveSettings, useAppState } from '../../app-state/store';
import { BUTTON_GROUPS, GESTURE_LABELS, Gesture, RawButtonEvent } from '../../buttons/gestures';
import { ACTIONS, ACTION_LABELS, DEFAULT_LAYOUT, isDefaultLayout, setMapping } from '../../buttons/mapping';
import { Body, Button, Card, Choice, Hint, Screen, colors } from '../../ui/kit';

const HINT_ID = 'buttons-intro';

const MODE_TEXT = {
  off: 'Handlebar buttons are ignored.',
  volume: 'Reads Up and Down. Your music keeps playing.',
  full: 'Reads every button. The app takes the place of your music player, so other music pauses.',
} as const;

function describeRaw(raw: RawButtonEvent): string {
  if (raw.type === 'volume') {
    return `Volume ${raw.delta > 0 ? 'up' : 'down'} by ${Math.round(Math.abs(raw.delta) * 100)}%`;
  }
  return { playPause: 'Play / pause key', next: 'Next-track key', previous: 'Previous-track key' }[raw.key];
}

export default function ButtonsScreen() {
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
        <Hint title="How the buttons work" onDismiss={() => dismissHint(HINT_ID)}>
          <Body dim>1. Pair the phone with the bike in iOS Bluetooth settings. Presses travel over Bluetooth.</Body>
          <Body dim>2. Choose below which buttons the app listens to.</Body>
          <Body dim>3. Press a button on the handlebar. It shows up under Last press.</Body>
          <Body dim>4. Tap any row under What each button does to change it.</Body>
        </Hint>
      ) : null}

      <Card title="Listen to">
        <Choice
          value={settings.buttonMode}
          onChange={(buttonMode) => {
            saveSettings({ buttonMode });
            void applyButtonMode();
          }}
          options={[
            { value: 'off', label: 'Nothing' },
            { value: 'volume', label: 'Up and Down' },
            { value: 'full', label: 'All buttons' },
          ]}
        />
        <Body dim>{MODE_TEXT[settings.buttonMode]}</Body>
      </Card>

      <Card title="Last press">
        {captureOff ? (
          <Body dim>Turn on listening above to see presses here.</Body>
        ) : last ? (
          <>
            <Text style={styles.lastGesture}>
              {last.gesture ? GESTURE_LABELS[last.gesture] : 'Not recognised as a button'}
            </Text>
            <Body dim>
              {last.gesture ? `Does: ${ACTION_LABELS[layout[last.gesture]]}. ` : ''}
              Phone received: {describeRaw(last.raw).toLowerCase()}.
            </Body>
          </>
        ) : (
          <Body dim>Nothing yet. Press a button on the handlebar.</Body>
        )}
      </Card>

      <Card title="What each button does">
        {BUTTON_GROUPS.map((group) => (
          <View key={group.button} style={styles.group}>
            <Text style={styles.groupTitle}>{group.button}</Text>
            {group.gestures.map(({ gesture, label }) => {
              const open = editing === gesture;
              const changed = layout[gesture] !== DEFAULT_LAYOUT[gesture];
              return (
                <View key={gesture}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${group.button}, ${label}: ${ACTION_LABELS[layout[gesture]]}`}
                    accessibilityState={{ expanded: open }}
                    onPress={() => setEditing(open ? null : gesture)}
                    style={styles.row}>
                    <Text style={styles.rowLabel}>{label}</Text>
                    <Text style={[styles.rowAction, changed && { color: colors.accent }]}>
                      {ACTION_LABELS[layout[gesture]]}
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
                              {ACTION_LABELS[action]}
                              {action === DEFAULT_LAYOUT[gesture] ? '  (default)' : ''}
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
          label="Restore default layout"
          kind="plain"
          disabled={isDefaultLayout(layout)}
          onPress={() => {
            saveLayout({ ...DEFAULT_LAYOUT });
            setEditing(null);
          }}
        />
        <Body dim>
          Hold is taken from the 450 MT manual: holding Up sends the previous-track key, holding Down the next-track
          key. Hold and Select need All buttons.
        </Body>
      </Card>

      <Card>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: advanced }}
          onPress={() => setAdvanced(!advanced)}
          style={styles.row}>
          <Text style={styles.advancedTitle}>Advanced</Text>
          <Text style={styles.chevron}>{advanced ? '▾' : '›'}</Text>
        </Pressable>
        {advanced ? (
          <>
            <Body dim>
              Up and Down arrive as phone volume changes. At full or zero volume a press changes nothing, so the app
              can put the volume back to the middle after each press.
            </Body>
            <Choice
              value={settings.pinVolume ? 'on' : 'off'}
              onChange={(value) => {
                saveSettings({ pinVolume: value === 'on' });
                void applyButtonMode();
              }}
              options={[
                { value: 'on', label: 'Keep volume at 50%' },
                { value: 'off', label: 'Leave volume alone' },
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
