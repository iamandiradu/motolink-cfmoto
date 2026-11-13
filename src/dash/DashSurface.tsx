import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { DashSurfaceView } from '../../modules/moto-link';
import { tapDashPage } from '../app-state/controller';
import { useAppState } from '../app-state/store';
import { useT } from '../i18n';
import { colors } from '../ui/kit';
import { PAGES, pageTitle } from './controller';
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
  const t = useT();
  const capture = useAppState((s) => s.link.capture);
  const mirroring = useAppState((s) => s.mirroring);
  const page = useAppState((s) => s.dash.page);
  const { width: screenWidth } = useWindowDimensions();
  const size = capture ? { width: capture.width, height: capture.height } : DEFAULT_SIZE;
  const scale = screenWidth / size.width;

  return (
    <View>
      <View style={styles.caption}>
        <Text style={styles.captionText} accessibilityRole="header">
          {mirroring ? t('dash.showingPhone') : t('dash.preview')}
        </Text>
      </View>
      {/* The tabs inside the picture are sized for the dash and come out tiny on
          the phone, so the phone gets its own full-size page buttons. */}
      {mirroring ? null : (
        <View style={styles.pages} accessibilityRole="tablist">
          {PAGES.map((item) => {
            const selected = item === page;
            return (
              <Pressable
                key={item}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={t('dash.pageA11y', { page: pageTitle(item) })}
                onPress={() => tapDashPage(item)}
                style={[styles.page, selected && styles.pageSelected]}>
                <Text style={[styles.pageLabel, selected && styles.pageLabelSelected]}>{pageTitle(item)}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <View
        style={{
          width: screenWidth,
          height: mirroring ? 0 : size.height * scale,
          overflow: 'hidden',
          backgroundColor: '#000',
        }}>
        <DashSurfaceView
          label={t('dash.pictureLabel')}
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
  pages: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  page: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  pageLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  pageLabelSelected: { color: colors.onAccent, fontWeight: '700' },
});
