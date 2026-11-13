import { View, useWindowDimensions } from 'react-native';

import { DashSurfaceView } from '../../modules/moto-link';
import { useAppState } from '../app-state/store';
import { DashScreen } from './DashScreen';

/** Size used until a dash has stated its own. Matches the 5" CFMOTO panels. */
const DEFAULT_SIZE = { width: 800, height: 384 };

/**
 * Hosts the dash picture. The native view is laid out at the dash's pixel
 * size and captured as is; the wrapper scales it down to phone width, so the
 * same view doubles as a live preview.
 */
export function DashSurface() {
  const capture = useAppState((s) => s.link.capture);
  const { width: screenWidth } = useWindowDimensions();
  const size = capture ? { width: capture.width, height: capture.height } : DEFAULT_SIZE;
  const scale = screenWidth / size.width;

  return (
    <View style={{ width: screenWidth, height: size.height * scale, overflow: 'hidden', backgroundColor: '#000' }}>
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
  );
}
