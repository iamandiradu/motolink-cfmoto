import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { DashSurfaceView } from '../../modules/moto-link';
import { useAppState } from '../app-state/store';
import { colors } from '../ui/kit';
import { DashScreen } from './DashScreen';

/** Size used until a dash has stated its own. Matches the 5" CFMOTO panels. */
const DEFAULT_SIZE = { width: 800, height: 384 };

/**
 * Hosts the dash picture. The native view is laid out at the dash's pixel
 * size and captured as is; the wrapper scales it down to phone width, so the
 * same view doubles as a live preview.
 *
 * While the phone screen is mirrored the dash does not show this picture, so
 * the preview folds away and a one-line note takes its place. The view stays
 * mounted: it is what the dash goes back to when mirroring stops.
 */
export function DashSurface() {
  const capture = useAppState((s) => s.link.capture);
  const mirroring = useAppState((s) => s.mirroring);
  const { width: screenWidth } = useWindowDimensions();
  const size = capture ? { width: capture.width, height: capture.height } : DEFAULT_SIZE;
  const scale = screenWidth / size.width;

  return (
    <View>
      <View style={styles.caption}>
        <Text style={styles.captionText} accessibilityRole="header">
          {mirroring ? 'Dash is showing your phone screen' : 'Dash preview'}
        </Text>
        {mirroring ? null : <Text style={styles.captionHint}>Tap to try it</Text>}
      </View>
      <View
        style={{
          width: screenWidth,
          height: mirroring ? 0 : size.height * scale,
          overflow: 'hidden',
          backgroundColor: '#000',
        }}>
        <DashSurfaceView
          label="Dash picture"
          style={{
            width: size.width,
            height: size.height,
            transformOrigin: 'top left',
            transform: [{ scale }],
          }}>
          <DashScreen />
        </DashSurfaceView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  captionText: { color: colors.dim, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  captionHint: { color: colors.dim, fontSize: 13 },
});
