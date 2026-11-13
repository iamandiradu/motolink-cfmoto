import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';

import { colors } from '../../ui/kit';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** One icon family at one size, so the bar reads as a set. */
const icon = (name: IconName) =>
  function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <Ionicons name={name} size={size} color={color as string} />;
  };

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.dim,
      }}>
      <Tabs.Screen name="index" options={{ title: 'Link', tabBarIcon: icon('swap-horizontal') }} />
      <Tabs.Screen name="buttons" options={{ title: 'Buttons', tabBarIcon: icon('game-controller-outline') }} />
      <Tabs.Screen name="metrics" options={{ title: 'Metrics', tabBarIcon: icon('speedometer-outline') }} />
      <Tabs.Screen name="rides" options={{ title: 'Rides', tabBarIcon: icon('map-outline') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings-outline') }} />
    </Tabs>
  );
}
