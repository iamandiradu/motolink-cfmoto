/**
 * The picture on the motorcycle dash. Rendered at the exact pixel size the
 * dash asked for and read at a glance from a metre away: few items, large
 * type, high contrast. No touch; a focus ring shows what Select will do.
 */
import { ReactNode, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView from 'react-native-maps';

import { useAppState } from '../app-state/store';
import { Metrics, compassPoint, formatClock, formatDuration, gpsQuality } from '../metrics/trip';
import { DashPage, DashState, PAGES, PAGE_ITEMS, PAGE_TITLES } from './controller';

interface Palette {
  bg: string;
  panel: string;
  text: string;
  dim: string;
  accent: string;
  warn: string;
}

const NIGHT: Palette = {
  bg: '#05070a',
  panel: '#131920',
  text: '#f4f7fa',
  dim: '#8996a3',
  accent: '#19c2d1',
  warn: '#ff9f1c',
};

const DAY: Palette = {
  bg: '#f2f4f6',
  panel: '#ffffff',
  text: '#0b1117',
  dim: '#4d5a66',
  accent: '#007f8c',
  warn: '#b85c00',
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

function Focusable(props: { focused: boolean; palette: Palette; children: ReactNode; grow?: boolean }) {
  const { focused, palette } = props;
  return (
    <View
      style={[
        styles.focusable,
        { backgroundColor: palette.panel, borderColor: focused ? palette.accent : 'transparent' },
        props.grow && styles.grow,
      ]}>
      {props.children}
    </View>
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
        <Text style={[styles.speed, { color: palette.text }]}>{units.speed(metrics.speedKmh)}</Text>
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
        <Focusable focused={dash.focus === 0} palette={palette}>
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
            userInterfaceStyle={dash.theme === 'night' ? 'dark' : 'light'}
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
          <Focusable key={item} focused={dash.focus === index} palette={palette} grow>
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
        <Focusable focused={dash.focus === 0} palette={palette}>
          <Text style={[styles.button, { color: palette.warn }]}>Reset trip</Text>
        </Focusable>
      </View>
    </View>
  );
}

function MenuPage({ dash, palette }: PageProps) {
  const labels: Record<string, string> = {
    ride: 'Ride',
    map: 'Map',
    trip: 'Trip',
    theme: dash.theme === 'night' ? 'Switch to day' : 'Switch to night',
  };
  return (
    <View style={styles.menu}>
      {PAGE_ITEMS.menu.map((item, index) => (
        <Focusable key={item} focused={dash.focus === index} palette={palette} grow>
          <Text style={[styles.menuItem, { color: palette.text }]}>{labels[item]}</Text>
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
  trip: TripPage,
  menu: MenuPage,
};

export function DashScreen() {
  const dash = useAppState((s) => s.dash);
  const metrics = useAppState((s) => s.metrics);
  const palette = dash.theme === 'night' ? NIGHT : DAY;
  const Page = PAGE_COMPONENTS[dash.page];

  return (
    <View style={[styles.screen, { backgroundColor: palette.bg }]}>
      <View style={styles.header}>
        {PAGES.map((page) => (
          <Text
            key={page}
            style={[
              styles.tab,
              { color: page === dash.page ? palette.accent : palette.dim },
              page === dash.page && { borderBottomColor: palette.accent },
            ]}>
            {PAGE_TITLES[page].toUpperCase()}
          </Text>
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
  header: { flexDirection: 'row', gap: 28, height: 40, alignItems: 'center' },
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
  menuItem: { fontSize: 36, fontWeight: '700' },
});
