import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { applyButtonMode, dispatchDashAction } from '../../app-state/controller';
import { saveLayout, saveSettings, useAppState } from '../../app-state/store';
import { GESTURES, GESTURE_LABELS, Gesture } from '../../buttons/gestures';
import { ACTIONS, ACTION_LABELS, DEFAULT_LAYOUT, DashAction, isDefaultLayout, setMapping } from '../../buttons/mapping';
import { Body, Button, Card, Choice, Screen, colors } from '../../ui/kit';

const PAD: { label: string; action: DashAction }[] = [
  { label: '▲ Previous', action: 'focusPrevious' },
  { label: '▼ Next', action: 'focusNext' },
  { label: 'Select', action: 'select' },
  { label: 'Back', action: 'back' },
  { label: '‹ Page', action: 'pagePrevious' },
  { label: 'Page ›', action: 'pageNext' },
];

function describeRaw(raw: NonNullable<ReturnType<typeof useLastButton>>['raw']): string {
  if (raw.type === 'volume') return `Volume ${raw.delta > 0 ? 'up' : 'down'} (${Math.round(Math.abs(raw.delta) * 100)}%)`;
  return { playPause: 'Play / pause key', next: 'Next-track key', previous: 'Previous-track key' }[raw.key];
}

function useLastButton() {
  return useAppState((s) => s.lastButton);
}

export default function ButtonsScreen() {
  const layout = useAppState((s) => s.layout);
  const settings = useAppState((s) => s.settings);
  const last = useLastButton();
  const [editing, setEditing] = useState<Gesture | null>(null);

  const setMode = (buttonMode: typeof settings.buttonMode) => {
    saveSettings({ buttonMode });
    void applyButtonMode();
  };

  return (
    <Screen>
      <Card title="Handlebar buttons">
        <Body dim>
          The dash sends button presses to the phone over Bluetooth, as volume changes and media keys. Pair the phone
          with the bike in iOS Bluetooth settings first.
        </Body>
        <Choice
          value={settings.buttonMode}
          onChange={setMode}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'volume', label: 'Up / down only' },
            { value: 'full', label: 'All buttons' },
          ]}
        />
        <Body dim>
          {settings.buttonMode === 'full'
            ? 'All buttons: the app acts as the music player to receive Select, Next and Previous. Other music pauses.'
            : settings.buttonMode === 'volume'
              ? 'Up / down only: reads the volume rocker. Your music keeps playing.'
              : 'Buttons do nothing. Use the pad below.'}
        </Body>
        <Choice
          value={settings.pinVolume ? 'on' : 'off'}
          onChange={(value) => {
            saveSettings({ pinVolume: value === 'on' });
            void applyButtonMode();
          }}
          options={[
            { value: 'on', label: 'Hold volume at 50%' },
            { value: 'off', label: 'Leave volume alone' },
          ]}
        />
      </Card>

      <Card title="Find your buttons">
        <Body dim>Press a button on the handlebar. What the phone received shows here.</Body>
        <View style={styles.lastBox}>
          <Text style={styles.lastRaw}>{last ? describeRaw(last.raw) : 'Nothing received yet'}</Text>
          {last ? (
            <Text style={styles.lastGesture}>
              {last.gesture ? `${GESTURE_LABELS[last.gesture]} → ${ACTION_LABELS[layout[last.gesture]]}` : 'Waiting for a second tap, or ignored'}
            </Text>
          ) : null}
        </View>
      </Card>

      <Card title="Layout">
        {GESTURES.map((gesture) => (
          <View key={gesture}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditing(editing === gesture ? null : gesture)}
              style={styles.mappingRow}>
              <Text style={styles.mappingGesture}>{GESTURE_LABELS[gesture]}</Text>
              <Text style={[styles.mappingAction, layout[gesture] !== DEFAULT_LAYOUT[gesture] && { color: colors.accent }]}>
                {ACTION_LABELS[layout[gesture]]}
              </Text>
            </Pressable>
            {editing === gesture ? (
              <View style={styles.editor}>
                <Choice
                  value={layout[gesture]}
                  onChange={(action) => {
                    saveLayout(setMapping(layout, gesture, action));
                    setEditing(null);
                  }}
                  options={ACTIONS.map((action) => ({ value: action, label: ACTION_LABELS[action] }))}
                />
              </View>
            ) : null}
          </View>
        ))}
        <Button
          label="Restore default layout"
          kind="plain"
          disabled={isDefaultLayout(layout)}
          onPress={() => saveLayout({ ...DEFAULT_LAYOUT })}
        />
      </Card>

      <Card title="Try it from the phone">
        <View style={styles.pad}>
          {PAD.map((key) => (
            <View key={key.label} style={styles.padKey}>
              <Button label={key.label} kind="plain" onPress={() => dispatchDashAction(key.action)} />
            </View>
          ))}
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lastBox: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, gap: 4 },
  lastRaw: { color: colors.text, fontSize: 16, fontWeight: '700' },
  lastGesture: { color: colors.dim, fontSize: 14 },
  mappingRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  mappingGesture: { color: colors.text, fontSize: 15, flexShrink: 1 },
  mappingAction: { color: colors.dim, fontSize: 15, fontWeight: '600' },
  editor: { paddingVertical: 10 },
  pad: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  padKey: { width: '48%', flexGrow: 1 },
});
