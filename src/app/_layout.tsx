import { useKeepAwake } from 'expo-keep-awake';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { bootstrap } from '../app-state/controller';
import { DashSurface } from '../dash/DashSurface';
import { colors } from '../ui/kit';

function Shell() {
  const insets = useSafeAreaInsets();
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
