/**
 * The picture on the motorcycle dash. Rendered at the exact pixel size the
 * dash asked for and read at a glance from a metre away: few items, large
 * type, high contrast. No touch; a focus ring shows what Select will do.
 */
import { ReactNode, useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView from 'react-native-maps';

import { tapDashItem, tapDashPage } from '../app-state/controller';
import { useAppState } from '../app-state/store';
import { Metrics, compassPoint, formatClock, formatDuration, gpsQuality } from '../metrics/trip';
import { currentProgressMs, formatTrackTime } from '../spotify/api';
import { DashPage, DashState, DashTheme, PAGES, PAGE_ITEMS, PAGE_TITLES, THEME_LABELS } from './controller';

interface Palette {
  bg: string;
  panel: string;
  text: string;
  dim: string;
  /** Focus ring and the active tab. */
  accent: string;
  /** Second brand colour: progress, highlights. */
  accent2: string;
  warn: string;
}

/** After the CFMOTO liveries. Every text colour clears 4.5:1 on its background. */
const PALETTES: Record<DashTheme, Palette> = {
  // Black with CFMOTO blue and pink.
  aurora: {
    bg: '#000000',
    panel: '#11161d',
    text: '#ffffff',
    dim: '#93a1b0',
    accent: '#00aeef',
    accent2: '#ff3d97',
    warn: '#ff3d97',
  },
  gray: {
    bg: '#30353a',
    panel: '#40474e',
    text: '#ffffff',
    dim: '#c2c9d0',
    accent: '#6fd0f7',
    accent2: '#ffa3cd',
    warn: '#ffc266',
  },
  graphite: {
    bg: '#15171a',
    panel: '#23272c',
    text: '#eceff2',
    dim: '#949ca5',
    accent: '#c9d0d7',
    accent2: '#00aeef',
    warn: '#ff9f1c',
  },
  day: {
    bg: '#f2f4f6',
    panel: '#ffffff',
    text: '#0b1117',
    dim: '#4d5a66',
    accent: '#00709c',
    accent2: '#c2185b',
    warn: '#a84300',
  },
};

const KM_TO_MI = 0.621371;

function useUnits() {
  const imperial = useAppState((s) => s.settings.units === 'imperial');
  return {
    speed: (kmh: number | null) => (kmh === null ? '--' : String(Math.round(imperial ? kmh * KM_TO_MI : kmh))),
    distance: (km: number) => (imperial ? km * KM_TO_MI : km).toFixed(1),
    speedUnit: imperial ? 'mph' : 'km/h',
    distanceUnit: imperial ? 'mi' : 'km',
  };
}

/** Time of day, refreshed often enough that the minute never lags visibly. */
function useClock(): string {
  const [now, setNow] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const timer = setInterval(() => setNow(formatClock(new Date())), 5000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * An item the handlebar buttons can focus. `index` is its place in the page's
 * focus order; tapping it in the phone preview does what Select does.
 */
function Focusable(props: { index: number; focus: number; palette: Palette; children: ReactNode; grow?: boolean }) {
  const { palette } = props;
  const focused = props.index === props.focus;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => tapDashItem(props.index)}
      style={[
        styles.focusable,
        { backgroundColor: palette.panel, borderColor: focused ? palette.accent : 'transparent' },
        props.grow && styles.grow,
      ]}>
      {props.children}
    </Pressable>
  );
}

function Stat(props: { label: string; value: string; unit?: string; palette: Palette; big?: boolean }) {
  const { palette } = props;
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: palette.dim }]}>{props.label}</Text>
      <Text style={[props.big ? styles.statValueBig : styles.statValue, { color: palette.text }]}>
        {props.value}
        {props.unit ? <Text style={[styles.statUnit, { color: palette.dim }]}> {props.unit}</Text> : null}
      </Text>
    </View>
  );
}

function RidePage({ metrics, dash, palette }: PageProps) {
  const units = useUnits();
  const clock = useClock();
  return (
    <View style={styles.row}>
      <View style={styles.speedBlock}>
        {/* No reading: a quiet placeholder, not a pair of blocks that looks like a fault. */}
        {metrics.speedKmh === null ? (
          <Text style={[styles.speedEmpty, { color: palette.dim }]}>- -</Text>
        ) : (
          <Text style={[styles.speed, { color: palette.text }]}>{units.speed(metrics.speedKmh)}</Text>
        )}
        <Text style={[styles.speedUnit, { color: gpsQuality(metrics.accuracyM) === 'good' ? palette.dim : palette.warn }]}>
          {gpsQuality(metrics.accuracyM) === 'good' ? units.speedUnit : gpsQuality(metrics.accuracyM) === 'poor' ? 'weak GPS' : 'no GPS'}
        </Text>
      </View>
      <View style={styles.column}>
        <View style={styles.row}>
          <Stat
            label="HEADING"
            value={metrics.headingDeg === null ? '--' : compassPoint(metrics.headingDeg)}
            unit={metrics.headingDeg === null ? undefined : `${Math.round(metrics.headingDeg)}°`}
            palette={palette}
          />
          <Stat label="TIME" value={clock} palette={palette} />
        </View>
        <View style={styles.row}>
          <Stat label="TRIP" value={units.distance(metrics.tripKm)} unit={units.distanceUnit} palette={palette} />
          <Stat
            label="ALTITUDE"
            value={metrics.altitudeM === null ? '--' : String(Math.round(metrics.altitudeM))}
            unit="m"
            palette={palette}
          />
        </View>
        <Focusable index={0} focus={dash.focus} palette={palette}>
          <Text style={[styles.button, { color: palette.text }]}>Map ›</Text>
        </Focusable>
      </View>
    </View>
  );
}

function MapPage({ metrics, dash, palette }: PageProps) {
  const units = useUnits();
  const hasFix = metrics.latitude !== null && metrics.longitude !== null;
  const items = PAGE_ITEMS.map;
  const labels: Record<string, string> = { zoomIn: '+', zoomOut: '−', recenter: '◎' };
  return (
    <View style={styles.row}>
      <View style={[styles.mapFrame, { backgroundColor: palette.panel }]}>
        {hasFix ? (
          <MapView
            style={StyleSheet.absoluteFill}
            userInterfaceStyle={dash.theme === 'day' ? 'light' : 'dark'}
            showsUserLocation
            showsCompass={false}
            toolbarEnabled={false}
            scrollEnabled={false}
            zoomEnabled={false}
            rotateEnabled={false}
            pitchEnabled={false}
            camera={{
              center: { latitude: metrics.latitude!, longitude: metrics.longitude! },
              heading: metrics.headingDeg ?? 0,
              pitch: 0,
              zoom: dash.zoom,
              // Apple Maps takes a camera height instead of a zoom level.
              altitude: 150 * 2 ** (19 - dash.zoom),
            }}
          />
        ) : (
          <Text style={[styles.placeholder, { color: palette.dim }]}>Waiting for GPS</Text>
        )}
        <View style={[styles.mapSpeed, { backgroundColor: palette.bg }]}>
          <Text style={[styles.mapSpeedValue, { color: palette.text }]}>{units.speed(metrics.speedKmh)}</Text>
          <Text style={[styles.statLabel, { color: palette.dim }]}>{units.speedUnit}</Text>
        </View>
      </View>
      <View style={styles.mapButtons}>
        {items.map((item, index) => (
          <Focusable key={item} index={index} focus={dash.focus} palette={palette} grow>
            <Text style={[styles.mapButton, { color: palette.text }]}>{labels[item]}</Text>
          </Focusable>
        ))}
      </View>
    </View>
  );
}

function TripPage({ metrics, dash, palette }: PageProps) {
  const units = useUnits();
  return (
    <View style={styles.column}>
      <View style={styles.row}>
        <Stat label="DISTANCE" value={units.distance(metrics.tripKm)} unit={units.distanceUnit} palette={palette} big />
        <Stat label="RIDING TIME" value={formatDuration(metrics.movingSeconds)} palette={palette} big />
      </View>
      <View style={styles.row}>
        <Stat label="AVERAGE" value={units.speed(metrics.avgSpeedKmh)} unit={units.speedUnit} palette={palette} />
        <Stat label="TOP" value={units.speed(metrics.maxSpeedKmh)} unit={units.speedUnit} palette={palette} />
        <Stat label="MAX LEAN ≈" value={`${Math.round(metrics.maxLeanDeg)}°`} palette={palette} />
        <Focusable index={0} focus={dash.focus} palette={palette}>
          <Text style={[styles.button, { color: palette.warn }]}>Reset trip</Text>
        </Focusable>
      </View>
    </View>
  );
}

// U+FE0E asks for the plain text glyph; without it iOS draws a coloured emoji.
const MUSIC_GLYPHS: Record<string, string> = { musicPrevious: '⏮\uFE0E', musicNext: '⏭\uFE0E' };

function MusicPage({ dash, palette }: PageProps) {
  const spotify = useAppState((s) => s.spotify);
  const playback = spotify.playback;
  // Re-render each second so the bar moves between polls.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const progress = playback ? currentProgressMs(playback, Date.now()) : 0;
  const share = playback && playback.durationMs > 0 ? progress / playback.durationMs : 0;
  const message = !spotify.connected
    ? 'Connect Spotify in the phone app'
    : (spotify.error ?? (playback ? null : 'Nothing playing. Start a song in Spotify.'));

  return (
    <View style={styles.row}>
      <View style={[styles.cover, { backgroundColor: palette.panel }]}>
        {playback?.imageUrl ? (
          <Image source={{ uri: playback.imageUrl }} style={StyleSheet.absoluteFill} accessibilityIgnoresInvertColors />
        ) : (
          <Text style={[styles.coverGlyph, { color: palette.dim }]}>♪</Text>
        )}
      </View>
      <View style={styles.column}>
        <View style={styles.trackText}>
          <Text numberOfLines={1} style={[styles.trackTitle, { color: palette.text }]}>
            {playback?.title || 'Spotify'}
          </Text>
          <Text numberOfLines={1} style={[styles.trackArtist, { color: message ? palette.warn : palette.dim }]}>
            {message ?? playback?.artist}
          </Text>
        </View>
        <View>
          <View style={[styles.bar, { backgroundColor: palette.panel }]}>
            <View style={[styles.barFill, { backgroundColor: palette.accent2, width: `${Math.round(share * 100)}%` }]} />
          </View>
          <View style={styles.times}>
            <Text style={[styles.time, { color: palette.dim }]}>{formatTrackTime(progress)}</Text>
            <Text style={[styles.time, { color: palette.dim }]}>{formatTrackTime(playback?.durationMs ?? 0)}</Text>
          </View>
        </View>
        <View style={styles.transport}>
          {PAGE_ITEMS.music.map((item, index) => (
            <Focusable key={item} index={index} focus={dash.focus} palette={palette} grow>
              <Text style={[styles.transportGlyph, { color: palette.text }]}>
                {MUSIC_GLYPHS[item] ?? (playback?.isPlaying ? '⏸\uFE0E' : '▶\uFE0E')}
              </Text>
            </Focusable>
          ))}
        </View>
      </View>
    </View>
  );
}

function MenuPage({ dash, palette }: PageProps) {
  const labels: Record<string, string> = {
    ride: 'Ride',
    map: 'Map',
    music: 'Music',
    trip: 'Trip',
    theme: THEME_LABELS[dash.theme],
  };
  return (
    <View style={styles.menu}>
      {PAGE_ITEMS.menu.map((item, index) => (
        <Focusable key={item} index={index} focus={dash.focus} palette={palette} grow>
          {item === 'theme' ? <Text style={[styles.menuCaption, { color: palette.dim }]}>COLOURS</Text> : null}
          <Text numberOfLines={2} style={[styles.menuItem, { color: palette.text }]}>
            {labels[item]}
          </Text>
        </Focusable>
      ))}
    </View>
  );
}

interface PageProps {
  metrics: Metrics;
  dash: DashState;
  palette: Palette;
}

const PAGE_COMPONENTS: Record<DashPage, (props: PageProps) => ReactNode> = {
  ride: RidePage,
  map: MapPage,
  music: MusicPage,
  trip: TripPage,
  menu: MenuPage,
};

export function DashScreen() {
  const dash = useAppState((s) => s.dash);
  const metrics = useAppState((s) => s.metrics);
  const palette = PALETTES[dash.theme];
  const Page = PAGE_COMPONENTS[dash.page];

  return (
    <View style={[styles.screen, { backgroundColor: palette.bg }]}>
      <View style={styles.header}>
        {PAGES.map((page) => (
          <Pressable key={page} accessibilityRole="tab" hitSlop={12} onPress={() => tapDashPage(page)}>
            <Text
              style={[
                styles.tab,
                { color: page === dash.page ? palette.accent : palette.dim },
                page === dash.page && { borderBottomColor: palette.accent2 },
              ]}>
              {PAGE_TITLES[page].toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.body}>
        <Page metrics={metrics} dash={dash} palette={palette} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 14 },
  header: { flexDirection: 'row', gap: 24, height: 40, alignItems: 'center' },
  tab: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 2,
    paddingBottom: 4,
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  body: { flex: 1, marginTop: 10 },
  row: { flex: 1, flexDirection: 'row', gap: 14 },
  column: { flex: 1, gap: 12 },
  grow: { flex: 1 },
  focusable: {
    borderWidth: 4,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedBlock: { width: 300, alignItems: 'center', justifyContent: 'center' },
  speed: { fontSize: 190, fontWeight: '800', lineHeight: 200, fontVariant: ['tabular-nums'] },
  speedEmpty: { fontSize: 96, fontWeight: '700', lineHeight: 200, letterSpacing: 6 },
  speedUnit: { fontSize: 28, fontWeight: '600', marginTop: -8 },
  stat: { flex: 1, justifyContent: 'center' },
  statLabel: { fontSize: 17, fontWeight: '700', letterSpacing: 1.5 },
  statValue: { fontSize: 46, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statValueBig: { fontSize: 84, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statUnit: { fontSize: 22, fontWeight: '600' },
  button: { fontSize: 30, fontWeight: '700' },
  mapFrame: { flex: 1, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  placeholder: { fontSize: 30, fontWeight: '600' },
  mapSpeed: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: 'center',
  },
  mapSpeedValue: { fontSize: 60, fontWeight: '800', lineHeight: 64, fontVariant: ['tabular-nums'] },
  mapButtons: { width: 110, gap: 10 },
  mapButton: { fontSize: 44, fontWeight: '700', lineHeight: 50 },
  menu: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  menuItem: { fontSize: 30, fontWeight: '700', textAlign: 'center' },
  menuCaption: { fontSize: 15, fontWeight: '700', letterSpacing: 1.5 },
  cover: { width: 290, borderRadius: 14, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  coverGlyph: { fontSize: 120 },
  trackText: { flex: 1, justifyContent: 'center' },
  trackTitle: { fontSize: 44, fontWeight: '800' },
  trackArtist: { fontSize: 28, fontWeight: '600', marginTop: 2 },
  bar: { height: 10, borderRadius: 5, overflow: 'hidden' },
  barFill: { height: 10, borderRadius: 5 },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  time: { fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  transport: { flexDirection: 'row', gap: 12, height: 84 },
  transportGlyph: { fontSize: 40, lineHeight: 48 },
});
