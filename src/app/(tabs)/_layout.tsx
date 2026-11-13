import { Tabs } from 'expo-router';
import { ColorValue, Text } from 'react-native';

import { colors } from '../../ui/kit';

const icon = (glyph: string) =>
  function TabIcon({ color }: { color: ColorValue }) {
    return <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
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
      <Tabs.Screen name="index" options={{ title: 'Link', tabBarIcon: icon('⇄') }} />
      <Tabs.Screen name="buttons" options={{ title: 'Buttons', tabBarIcon: icon('◉') }} />
      <Tabs.Screen name="metrics" options={{ title: 'Metrics', tabBarIcon: icon('◔') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('⚙') }} />
    </Tabs>
  );
}
