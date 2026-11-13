/**
 * Service reminders: what is due, "Done" to reset, intervals the rider can
 * change, and distance from rides that were not recorded.
 */
import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { t as translateNow, useT } from '../i18n';
import { Body, Button, Card, Label, Stepper, colors, confirm } from '../ui/kit';
import { formatKm, KM_TO_MI } from './format';
import { MAX_INTERVAL_KM, MAX_MANUAL_KM, MIN_INTERVAL_KM, type ServiceItemStatus, type ServiceStatus } from './service';
import { useService } from './serviceStore';

export interface ServiceCardProps {
  imperial?: boolean;
}

const STATUS_COLOR: Record<ServiceStatus, string> = { ok: colors.ok, soon: colors.warn, due: colors.danger };

/**
 * The built-in items are stored with an English name; show them by id in the
 * current language. Unknown ids keep the stored name.
 */
const ITEM_KEYS: Record<string, 'chainLube' | 'chainAdjust' | 'oil'> = {
  'chain-lube': 'chainLube',
  'chain-adjust': 'chainAdjust',
  oil: 'oil',
};

function itemName(item: ServiceItemStatus): string {
  const key = ITEM_KEYS[item.id];
  return key ? translateNow(`service.items.${key}.name`) : item.name;
}

/** Whole label, per item, because some languages cannot just lower-case a name into the sentence. */
function markDoneLabel(item: ServiceItemStatus): string {
  const key = ITEM_KEYS[item.id];
  return key
    ? translateNow(`service.items.${key}.markDone`)
    : translateNow('service.markDone', { item: item.name.toLowerCase() });
}

const statusText = (status: ServiceStatus) => translateNow(`service.status.${status}`);

/** Parses "1,234.5" or "1234,5" typed on a phone keypad. NaN when it is not a number. */
function parseNumber(text: string): number {
  const cleaned = text.trim().replace(/\s/g, '');
  if (!cleaned) return NaN;
  const normalised = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  return /^\d+(\.\d+)?$/.test(normalised) ? Number(normalised) : NaN;
}

export function ServiceCard({ imperial = false }: ServiceCardProps) {
  const t = useT();
  const { service, statuses, loaded, addDistance, setOdometer, markDone, setInterval } = useService();
  const [editing, setEditing] = useState(false);
  const [extra, setExtra] = useState('');
  const [odo, setOdo] = useState('');
  const unit = imperial ? 'mi' : 'km';
  const toKm = (v: number) => (imperial ? v / KM_TO_MI : v);
  const fromKm = (km: number) => Math.round(imperial ? km * KM_TO_MI : km);
  const fail = () => Alert.alert(t('service.saveFailedTitle'), t('service.saveFailedBody'));

  const onAdd = () => {
    const v = parseNumber(extra);
    if (!Number.isFinite(v) || v <= 0 || toKm(v) > MAX_MANUAL_KM) {
      Alert.alert(t('service.checkDistance'), t('service.checkDistanceBody', { unit }));
      return;
    }
    addDistance(toKm(v)).then(() => setExtra(''), fail);
  };

  const onOdometer = () => {
    const v = parseNumber(odo);
    if (!Number.isFinite(v) || v < 0) {
      Alert.alert(t('service.checkOdometer'), t('service.checkOdometerBody', { unit }));
      return;
    }
    setOdometer(toKm(v)).then(() => setOdo(''), fail);
  };

  const onDone = (item: ServiceItemStatus) =>
    confirm(t('service.doneTitle', { item: itemName(item) }), t('service.doneBody', { unit }), t('common.done'), () => {
      markDone(item.id).catch(fail);
    });

  return (
    <Card title={t('service.title')} collapsible defaultOpen>
      <Body dim>{t('service.disclaimer')}</Body>

      {!loaded ? <Body dim>{t('service.loading')}</Body> : null}

      {loaded
        ? statuses.map((item) => (
            <View key={item.id} style={styles.item}>
              <View style={styles.itemHeader} accessible accessibilityLabel={itemA11y(item, imperial)}>
                <Text style={styles.itemName}>{itemName(item)}</Text>
                <View style={[styles.badge, { borderColor: STATUS_COLOR[item.status] }]}>
                  <Text style={[styles.badgeText, { color: STATUS_COLOR[item.status] }]}>{statusText(item.status)}</Text>
                </View>
              </View>
              <Body dim>
                {t('service.progress', { since: formatKm(item.kmSinceDone, imperial), interval: formatKm(item.intervalKm, imperial) })}{' '}
                {item.remainingKm > 0
                  ? t('service.toGo', { km: formatKm(item.remainingKm, imperial) })
                  : t('service.overdue', { km: formatKm(-item.remainingKm, imperial) })}
              </Body>
              {editing ? (
                <Stepper
                  label={t('service.every')}
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
              <Button label={markDoneLabel(item)} kind="plain" onPress={() => onDone(item)} />
            </View>
          ))
        : null}

      <Button label={editing ? t('service.finishIntervals') : t('service.changeIntervals')} kind="plain" onPress={() => setEditing(!editing)} />

      <Label>{t('service.unrecorded')}</Label>
      <Body dim>{t('service.recordedAdded')}</Body>
      <View style={styles.inputRow}>
        <TextInput
          value={extra}
          onChangeText={setExtra}
          placeholder={t('service.distancePlaceholder', { unit })}
          placeholderTextColor={colors.dim}
          keyboardType="decimal-pad"
          accessibilityLabel={t('service.distanceA11y', { unit })}
          returnKeyType="done"
          onSubmitEditing={onAdd}
          style={styles.input}
        />
        <View style={styles.inputButton}>
          <Button label={t('service.add')} onPress={onAdd} disabled={!extra.trim()} />
        </View>
      </View>

      <Label>{t('service.odometer')}</Label>
      <Body dim>
        {service.odometerKm === null
          ? t('service.odometerNotSet')
          : t('service.odometerLast', { km: formatKm(service.odometerKm, imperial) })}
      </Body>
      <View style={styles.inputRow}>
        <TextInput
          value={odo}
          onChangeText={setOdo}
          placeholder={t('service.readingPlaceholder', { unit })}
          placeholderTextColor={colors.dim}
          keyboardType="number-pad"
          accessibilityLabel={t('service.readingA11y', { unit })}
          returnKeyType="done"
          onSubmitEditing={onOdometer}
          style={styles.input}
        />
        <View style={styles.inputButton}>
          <Button label={t('service.set')} onPress={onOdometer} disabled={!odo.trim()} />
        </View>
      </View>
    </Card>
  );
}

function itemA11y(item: ServiceItemStatus, imperial: boolean): string {
  return translateNow('service.itemA11y', {
    item: itemName(item),
    status: statusText(item.status),
    since: formatKm(item.kmSinceDone, imperial),
    interval: formatKm(item.intervalKm, imperial),
  });
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
