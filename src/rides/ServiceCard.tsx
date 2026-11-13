/**
 * Service reminders: what is due, "Done" to reset, intervals the rider can
 * change, and distance from rides that were not recorded.
 */
import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { Body, Button, Card, Label, Stepper, colors, confirm } from '../ui/kit';
import { formatKm, KM_TO_MI } from './format';
import { MAX_INTERVAL_KM, MAX_MANUAL_KM, MIN_INTERVAL_KM, type ServiceItemStatus, type ServiceStatus } from './service';
import { useService } from './serviceStore';

export interface ServiceCardProps {
  imperial?: boolean;
}

const STATUS_TEXT: Record<ServiceStatus, string> = { ok: 'OK', soon: 'Soon', due: 'Due' };
const STATUS_COLOR: Record<ServiceStatus, string> = { ok: colors.ok, soon: colors.warn, due: colors.danger };

/** Parses "1,234.5" or "1234,5" typed on a phone keypad. NaN when it is not a number. */
function parseNumber(text: string): number {
  const cleaned = text.trim().replace(/\s/g, '');
  if (!cleaned) return NaN;
  const normalised = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  return /^\d+(\.\d+)?$/.test(normalised) ? Number(normalised) : NaN;
}

export function ServiceCard({ imperial = false }: ServiceCardProps) {
  const { service, statuses, loaded, addDistance, setOdometer, markDone, setInterval } = useService();
  const [editing, setEditing] = useState(false);
  const [extra, setExtra] = useState('');
  const [odo, setOdo] = useState('');
  const unit = imperial ? 'mi' : 'km';
  const toKm = (v: number) => (imperial ? v / KM_TO_MI : v);
  const fromKm = (km: number) => Math.round(imperial ? km * KM_TO_MI : km);
  const fail = () => Alert.alert('Could not save', 'The phone storage did not accept the change.');

  const onAdd = () => {
    const v = parseNumber(extra);
    if (!Number.isFinite(v) || v <= 0 || toKm(v) > MAX_MANUAL_KM) {
      Alert.alert('Check the distance', `Enter the ${unit} ridden, for example 120.`);
      return;
    }
    addDistance(toKm(v)).then(() => setExtra(''), fail);
  };

  const onOdometer = () => {
    const v = parseNumber(odo);
    if (!Number.isFinite(v) || v < 0) {
      Alert.alert('Check the odometer', `Enter the reading in ${unit}, for example 12500.`);
      return;
    }
    setOdometer(toKm(v)).then(() => setOdo(''), fail);
  };

  const onDone = (item: ServiceItemStatus) =>
    confirm(`${item.name} done?`, `This sets it back to 0 ${unit}.`, 'Done', () => {
      markDone(item.id).catch(fail);
    });

  return (
    <Card title="Service reminders" collapsible defaultOpen>
      <Body dim>
        These intervals are generic guesses, not CFMOTO&apos;s schedule. Follow your owner&apos;s manual and change them below.
      </Body>

      {!loaded ? <Body dim>Loading…</Body> : null}

      {loaded
        ? statuses.map((item) => (
            <View key={item.id} style={styles.item}>
              <View style={styles.itemHeader} accessible accessibilityLabel={itemA11y(item, imperial)}>
                <Text style={styles.itemName}>{item.name}</Text>
                <View style={[styles.badge, { borderColor: STATUS_COLOR[item.status] }]}>
                  <Text style={[styles.badgeText, { color: STATUS_COLOR[item.status] }]}>{STATUS_TEXT[item.status]}</Text>
                </View>
              </View>
              <Body dim>
                {formatKm(item.kmSinceDone, imperial)} since done, every {formatKm(item.intervalKm, imperial)}.{' '}
                {item.remainingKm > 0
                  ? `${formatKm(item.remainingKm, imperial)} to go.`
                  : `${formatKm(-item.remainingKm, imperial)} overdue.`}
              </Body>
              {editing ? (
                <Stepper
                  label="Every"
                  value={fromKm(item.intervalKm)}
                  unit={` ${unit}`}
                  min={fromKm(MIN_INTERVAL_KM)}
                  max={fromKm(MAX_INTERVAL_KM)}
                  step={imperial ? 50 : 100}
                  onChange={(v) => {
                    setInterval(item.id, toKm(v)).catch(fail);
                  }}
                />
              ) : null}
              <Button label={`Mark ${item.name.toLowerCase()} done`} kind="plain" onPress={() => onDone(item)} />
            </View>
          ))
        : null}

      <Button label={editing ? 'Finish changing intervals' : 'Change intervals'} kind="plain" onPress={() => setEditing(!editing)} />

      <Label>Rides you did not record</Label>
      <Body dim>Recorded rides are added when you press Stop.</Body>
      <View style={styles.inputRow}>
        <TextInput
          value={extra}
          onChangeText={setExtra}
          placeholder={`Distance in ${unit}`}
          placeholderTextColor={colors.dim}
          keyboardType="decimal-pad"
          accessibilityLabel={`Distance to add, in ${unit}`}
          returnKeyType="done"
          onSubmitEditing={onAdd}
          style={styles.input}
        />
        <View style={styles.inputButton}>
          <Button label="Add" onPress={onAdd} disabled={!extra.trim()} />
        </View>
      </View>

      <Label>Bike odometer</Label>
      <Body dim>
        {service.odometerKm === null
          ? 'Not set. Enter the reading from the dash; later readings add the distance since.'
          : `Last reading ${formatKm(service.odometerKm, imperial)}, plus recorded rides.`}
      </Body>
      <View style={styles.inputRow}>
        <TextInput
          value={odo}
          onChangeText={setOdo}
          placeholder={`Reading in ${unit}`}
          placeholderTextColor={colors.dim}
          keyboardType="number-pad"
          accessibilityLabel={`Odometer reading, in ${unit}`}
          returnKeyType="done"
          onSubmitEditing={onOdometer}
          style={styles.input}
        />
        <View style={styles.inputButton}>
          <Button label="Set" onPress={onOdometer} disabled={!odo.trim()} />
        </View>
      </View>
    </Card>
  );
}

function itemA11y(item: ServiceItemStatus, imperial: boolean): string {
  return `${item.name}: ${STATUS_TEXT[item.status]}. ${formatKm(item.kmSinceDone, imperial)} since done, every ${formatKm(item.intervalKm, imperial)}.`;
}

export default ServiceCard;

const styles = StyleSheet.create({
  item: { gap: 8, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  itemHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  itemName: { color: colors.text, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  badge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 14, fontWeight: '800' },
  inputRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  input: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
  },
  inputButton: { width: 96 },
});
