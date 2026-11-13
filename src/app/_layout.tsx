import { useKeepAwake } from 'expo-keep-awake';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { bootstrap, toggleMirroring } from '../app-state/controller';
import { saveSettings, useAppState } from '../app-state/store';
import { DashSurface } from '../dash/DashSurface';
import { Onboarding } from '../onboarding/Onboarding';
import { colors } from '../ui/kit';

function Shell() {
  const insets = useSafeAreaInsets();
  const loaded = useAppState((s) => s.loaded);
  const onboardingDone = useAppState((s) => s.settings.onboardingDone);
  const onboardingStep = useAppState((s) => s.settings.onboardingStep);
  const bike = useAppState((s) => s.bike);
  const linkState = useAppState((s) => s.link.state);
  const mirroring = useAppState((s) => s.mirroring);
  const finishOnboarding = () => saveSettings({ onboardingDone: true });
  // The picture is captured from a live view, so the screen must stay on.
  useKeepAwake();

  useEffect(() => {
    void bootstrap();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <StatusBar style="light" />
      {/* Always mounted: this is the picture the dash shows, and its preview. */}
      <DashSurface />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="scan" options={{ title: 'Scan the dash QR', presentation: 'modal' }} />
      </Stack>
      {/* First run only. Stays mounted under the scan sheet so it sees the bike appear. */}
      {loaded && !onboardingDone ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
          <Onboarding
            bike={bike ? { ssid: bike.ssid, password: bike.password } : null}
            linkState={linkState}
            mirroring={mirroring}
            initialStep={onboardingStep}
            onStepChange={(step) => saveSettings({ onboardingStep: step })}
            onScan={() => router.push('/scan')}
            onStartMirroring={toggleMirroring}
            onFinish={finishOnboarding}
            onSkip={finishOnboarding}
          />
        </View>
      ) : null}
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}
