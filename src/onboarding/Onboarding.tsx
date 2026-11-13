/**
 * First-run onboarding. Full screen, skippable at any time, resumable through
 * initialStep + onStepChange. Takes everything through props.
 */
import { ComponentRef, ReactNode, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TFunction, useT } from '../i18n';
import type { LinkState } from '../protocol/session';
import { colors } from '../ui/kit';
import {
  OnboardingState,
  STEP_COUNT,
  StepId,
  isOnDashNetwork,
  nextStep,
  prevStep,
  progressLabel,
  resolveStep,
  shouldAutoAdvance,
  stepIndex,
  stepTitle,
} from './steps';
import { Action, Status } from './ui';
import { WifiHelper } from './WifiHelper';

export interface OnboardingProps {
  /** Credentials from the scanned QR, null until scanned. */
  bike: { ssid: string; password: string } | null;
  linkState: LinkState;
  mirroring: boolean;
  onScan: () => void;
  onStartMirroring: () => void;
  /** Rider finished the last step. */
  onFinish: () => void;
  /** Rider left early with Skip. */
  onSkip: () => void;
  /** Where to resume. Unknown values start at the beginning. */
  initialStep?: StepId | string | null;
  /** Called on every step change, so the caller can persist progress. */
  onStepChange?: (step: StepId) => void;
}

/** Pause before moving on after a check turns true, so the rider sees and hears the success. */
const AUTO_ADVANCE_MS = 1500;

export function Onboarding(props: OnboardingProps) {
  const t = useT();
  const [step, setStep] = useState<StepId>(() => resolveStep(props.initialStep));
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const headingRef = useRef<ComponentRef<typeof Text>>(null);
  const firstRender = useRef(true);

  const state: OnboardingState = {
    hasBike: props.bike !== null,
    onDashNetwork: isOnDashNetwork(props.linkState),
    mirroring: props.mirroring,
  };
  const previous = useRef(state);

  // Kept in a ref so an inline callback from the parent does not re-run the step effect.
  const onStepChange = useRef(props.onStepChange);
  onStepChange.current = props.onStepChange;
  const goTo = (next: StepId | null) => {
    if (next) setStep(next);
  };

  // Report the step, scroll to the top and move screen reader focus to the heading.
  useEffect(() => {
    onStepChange.current?.(step);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    const timer = setTimeout(() => {
      if (headingRef.current) AccessibilityInfo.sendAccessibilityEvent(headingRef.current, 'focus');
    }, 100);
    return () => clearTimeout(timer);
  }, [step]);

  // Move on by itself when the current step's check turns true.
  const { hasBike, onDashNetwork, mirroring } = state;
  useEffect(() => {
    const before = previous.current;
    const after = { hasBike, onDashNetwork, mirroring };
    previous.current = after;
    if (!shouldAutoAdvance(step, before, after)) return;
    AccessibilityInfo.announceForAccessibility(t('onboarding.moving', { success: successText(t, step) }));
    const timer = setTimeout(() => goTo(nextStep(step)), AUTO_ADVANCE_MS);
    return () => clearTimeout(timer);
    // t is left out on purpose: a language change must not re-announce or restart the timer.
  }, [step, hasBike, onDashNetwork, mirroring]);

  const index = stepIndex(step);
  const back = prevStep(step);
  const forward = nextStep(step);
  const content = renderStep(t, step, props, state, goTo);

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.progress} accessibilityRole="text">
            {progressLabel(step)}
          </Text>
          {forward ? (
            <Action compact kind="quiet" label={t('onboarding.skip')} accessibilityLabel={t('onboarding.skipA11y')} accessibilityHint={t('onboarding.skipHint')} onPress={props.onSkip} />
          ) : null}
        </View>
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel={t('onboarding.progressA11y')}
          accessibilityValue={{ min: 1, max: STEP_COUNT, now: index + 1 }}>
          <View style={[styles.fill, { width: `${((index + 1) / STEP_COUNT) * 100}%` }]} />
        </View>
      </View>

      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content}>
        <Text ref={headingRef} style={styles.heading} accessibilityRole="header">
          {stepTitle(step)}
        </Text>
        {content.node}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerSlot}>
          {back ? <Action kind="plain" label={t('onboarding.back')} accessibilityLabel={t('onboarding.backTo', { step: stepTitle(back) })} onPress={() => goTo(back)} /> : null}
        </View>
        <View style={styles.footerSlot}>
          {forward ? (
            <Action
              kind={content.primaryInBody ? 'plain' : 'primary'}
              label={t('onboarding.next')}
              accessibilityLabel={t('onboarding.nextTo', { step: stepTitle(forward) })}
              onPress={() => goTo(forward)}
            />
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

function successText(t: TFunction, step: StepId): string {
  switch (step) {
    case 'scan':
      return t('onboarding.success.scan');
    case 'wifi':
      return t('onboarding.success.wifi');
    case 'mirror':
      return t('onboarding.success.mirror');
    default:
      return t('onboarding.success.done');
  }
}

function Para({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

/** Step bodies. `primaryInBody` tells the footer to make Next a plain button. */
function renderStep(
  t: TFunction,
  step: StepId,
  props: OnboardingProps,
  state: OnboardingState,
  goTo: (step: StepId | null) => void,
): { node: ReactNode; primaryInBody: boolean } {
  const wrap = (node: ReactNode, primaryInBody: boolean) => ({ node, primaryInBody });
  const openSettings = () => {
    Linking.openSettings().catch(() => undefined);
  };

  switch (step) {
    case 'about':
      return wrap(
        <View style={styles.block}>
          <Para>{t('onboarding.about1')}</Para>
          <Para>{t('onboarding.about2')}</Para>
        </View>,
        false,
      );
    case 'bluetooth':
      return wrap(
        <View style={styles.block}>
          <Para>{t('onboarding.bt1')}</Para>
          <Para>{t('onboarding.bt2')}</Para>
          <Action label={t('onboarding.openSettings')} accessibilityHint={t('onboarding.openSettingsHint')} onPress={openSettings} />
          <Text style={styles.small}>{t('onboarding.btSmall')}</Text>
        </View>,
        true,
      );
    case 'closeApp':
      return wrap(
        <View style={styles.block}>
          <Para>{t('onboarding.close1')}</Para>
          <Para>{t('onboarding.close2')}</Para>
        </View>,
        false,
      );
    case 'scan':
      return wrap(
        <View style={styles.block}>
          <Para>{t('onboarding.scan1')}</Para>
          <Para>{t('onboarding.scan2')}</Para>
          {props.bike ? (
            <Status ok>{t('onboarding.scanned', { ssid: props.bike.ssid })}</Status>
          ) : (
            <Status ok={false}>{t('onboarding.notScanned')}</Status>
          )}
          <Action
            kind={props.bike ? 'plain' : 'primary'}
            label={props.bike ? t('onboarding.scanAgain') : t('onboarding.scanQr')}
            onPress={props.onScan}
          />
        </View>,
        !props.bike,
      );
    case 'wifi':
      if (!props.bike) {
        return wrap(
          <View style={styles.block}>
            <Status ok={false}>{t('onboarding.scanFirst')}</Status>
            <Action
              label={t('onboarding.goScan')}
              accessibilityLabel={t('onboarding.backTo', { step: stepTitle('scan') })}
              onPress={() => goTo('scan')}
            />
          </View>,
          true,
        );
      }
      return wrap(
        <View style={styles.block}>
          <Para>{t('onboarding.wifiKeep')}</Para>
          <WifiHelper
            ssid={props.bike.ssid}
            password={props.bike.password}
            connected={state.onDashNetwork}
            onDone={state.onDashNetwork ? () => goTo(nextStep('wifi')) : undefined}
          />
        </View>,
        true,
      );
    case 'mirror':
      return wrap(
        <View style={styles.block}>
          <Para>{t('onboarding.mirror1')}</Para>
          <Para>{t('onboarding.mirror2')}</Para>
          {props.mirroring ? (
            <Status ok>{t('onboarding.mirrorOn')}</Status>
          ) : !state.onDashNetwork ? (
            <Status ok={false}>{t('onboarding.mirrorNotConnected')}</Status>
          ) : null}
          {props.mirroring ? null : <Action label={t('onboarding.startMirroring')} onPress={props.onStartMirroring} />}
        </View>,
        !props.mirroring,
      );
    case 'done':
      return wrap(
        <View style={styles.block}>
          <Para>{t('onboarding.done1')}</Para>
          <Para>{t('onboarding.done2')}</Para>
          <Action label={t('onboarding.finish')} accessibilityHint={t('onboarding.finishHint')} onPress={props.onFinish} />
        </View>,
        true,
      );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  progress: { color: colors.dim, fontSize: 15, fontWeight: '600' },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: colors.accent },
  scroll: { flex: 1 },
  content: { padding: 16, gap: 16, paddingBottom: 32 },
  heading: { color: colors.text, fontSize: 26, fontWeight: '800' },
  block: { gap: 14 },
  body: { color: colors.text, fontSize: 17, lineHeight: 24 },
  small: { color: colors.dim, fontSize: 15, lineHeight: 21 },
  footer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  footerSlot: { flex: 1 },
});
