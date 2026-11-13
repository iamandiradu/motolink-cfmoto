/**
 * Wires the pieces together: link session, handlebar buttons, dash UI state
 * and metrics. Module-level singletons; the bike has one dash.
 */
import { AppState, Platform } from 'react-native';

import { MotoLink, NativeButtonEvent } from '../../modules/moto-link';
import { Gesture, GestureDetector } from '../buttons/gestures';
import { DashAction, resolveAction } from '../buttons/mapping';
import { DashPage, DashState, DashTheme, THEMES, dashReducer, setTheme, showPage, tapItem } from '../dash/controller';
import { nativeTransport } from '../link/nativeTransport';
import { AlertTracker, ComfortSettings, EMPTY_FUEL, pickStripAlert, refuel, themeForTime, trackTrip } from '../comfort';
import { watchBattery } from '../comfort/battery';
import { say } from '../comfort/speech';
import { PhoneSensorSource } from '../metrics/phoneSensors';
import { MirrorView, PresetId, toNativeView, updatePreset } from '../mirror/presets';
import { NativeStrip, StripEdge, buildStrip, sameStrip } from '../mirror/strip';
import { TripComputer } from '../metrics/trip';
import { DEFAULT_IDENTITY } from '../protocol/control';
import { feedSample } from '../rides';
import { LinkSession, LinkState } from '../protocol/session';
import { bootstrapSpotify, musicCommand, setMusicPageVisible } from '../spotify/session';
import {
  allProfiles,
  chooseProfile,
  emptyLearned,
  evidenceFrom,
  learnFromSnapshot,
  matchProfile,
  parseProfileJson,
  sessionOptionsFor,
} from '../bikes';
import { loadCustomProfiles, loadLearnedBike, saveCustomProfile, saveLearnedBike } from '../bikes/storage';
import { bikeConnected, onBluetoothChange } from './autoStart';
import { activityState, shouldShowActivity } from './liveActivity';
import { appendLog, getState, loadPersisted, saveSettings, setState } from './store';

let session: LinkSession | null = null;
let previousLinkState: LinkState = 'idle';
let buttonSubscription: { remove(): void } | null = null;
let logSubscription: { remove(): void } | null = null;
let mirrorSubscription: { remove(): void } | null = null;
let routeSubscription: { remove(): void } | null = null;
let appStateSubscription: { remove(): void } | null = null;

const trip = new TripComputer();
const phoneSensors = new PhoneSensorSource();
let metricsRunning = false;
let lastSampleAt = 0;
/** No GPS reading for this long means the shown speed is no longer true. */
const GPS_STALE_MS = 5000;

/** Runs a dash action, whether it came from a handlebar button or the phone screen. */
export function dispatchDashAction(action: DashAction): void {
  applyDash((state) => dashReducer(state, action));
}

/** A tap on a page tab in the phone preview. The dash itself has no touch. */
export function tapDashPage(page: DashPage): void {
  applyDash((state) => showPage(state, page));
}

/** A tap on a focusable item in the phone preview. */
export function tapDashItem(index: number): void {
  applyDash((state) => tapItem(state, index));
}

function applyDash(change: (state: DashState) => DashState): void {
  const before = getState().dash;
  const after = change(before);
  if (after === before) return;
  setState({ dash: after });
  if (after.tripResetToken !== before.tripResetToken) setState({ metrics: trip.resetTrip() });
  if (after.theme !== before.theme) saveSettings({ dashTheme: after.theme });
  if (after.music && after.music.id !== before.music?.id) void musicCommand(after.music.request);
  if (after.page !== before.page) setMusicPageVisible(after.page === 'music');
}

export function setDashTheme(theme: DashTheme): void {
  applyDash((state) => setTheme(state, theme));
}

let pendingGesture: Gesture | null = null;

const detector = new GestureDetector(
  (gesture) => {
    pendingGesture = gesture;
    dispatchDashAction(resolveAction(getState().layout, gesture));
  },
  { wantsDouble: (gesture) => resolveAction(getState().layout, gesture) !== 'none' },
);

function onButton(raw: NativeButtonEvent): void {
  pendingGesture = null;
  detector.handle(raw);
  setState({ lastButton: { raw, gesture: pendingGesture, at: Date.now() } });
}

export async function applyButtonMode(): Promise<void> {
  const { buttonMode, pinVolume } = getState().settings;
  try {
    // Even with buttons off, the silent audio stays on: it is what keeps the
    // dash link alive while another app (Waze) is on screen.
    await MotoLink.startButtonCapture(buttonMode === 'off' ? 'keepAlive' : buttonMode, pinVolume);
  } catch (error) {
    appendLog(`button capture: ${String(error)}`);
  }
}

export async function startMetrics(): Promise<void> {
  if (metricsRunning) return;
  metricsRunning = true;
  try {
    await phoneSensors.start(
      (sample) => {
        lastSampleAt = Date.now();
        setState({ metrics: trip.add(sample) });
        syncMirrorStrip();
        runComfort();
        // Does nothing unless the rider pressed Record.
        feedSample(sample);
        syncLiveActivity();
      },
      (motion) => {
        // Motion arrives ten times a second; only publish when the lean actually moved.
        const next = trip.addMotion(motion);
        const shown = getState().metrics;
        if (next !== shown && Math.round(next.leanDeg ?? 0) !== Math.round(shown.leanDeg ?? 0)) {
          setState({ metrics: next });
        }
      },
    );
    setInterval(() => {
      // Also keeps the strip's clock moving when GPS is quiet.
      syncMirrorStrip();
      if (Date.now() - lastSampleAt < GPS_STALE_MS) return;
      const stale = trip.markStale();
      if (stale !== getState().metrics) setState({ metrics: stale });
    }, 2000);
  } catch (error) {
    metricsRunning = false;
    appendLog(`metrics: ${String(error)}`);
  }
}

/** Sends the active preset's crop, zoom and fit to the broadcast extension. */
export function applyMirrorView(): void {
  const { mirrorPresets, mirrorPreset } = getState().settings;
  MotoLink.setMirrorView(toNativeView(mirrorPresets[mirrorPreset]));
}

/** Switches to another app's picture settings. */
export function selectMirrorPreset(id: PresetId): void {
  saveSettings({ mirrorPreset: id });
  applyMirrorView();
}

export function changeMirrorPreset(id: PresetId, patch: Partial<MirrorView>): void {
  saveSettings({ mirrorPresets: updatePreset(getState().settings.mirrorPresets, id, patch) });
  applyMirrorView();
}

/** Opens the iOS sheet that starts or stops mirroring the phone screen. */
export function toggleMirroring(): void {
  // The rider is stopping it on purpose.
  if (getState().mirroring) mirroringExpected = false;
  void MotoLink.showBroadcastPicker().catch((error) => appendLog(`mirroring: ${String(error)}`));
}

/** Works out which bike this is from the QR, what the dash said before, and the rider's own pick. */
function matchBike(): void {
  const { bike, learnedBike, customProfiles, link } = getState();
  if (!bike) {
    setState({ bikeMatch: null });
    return;
  }
  setState({
    bikeMatch: matchProfile(evidenceFrom({ credentials: bike, snapshot: link, learned: learnedBike }), {
      manualId: learnedBike?.chosenProfileId ?? undefined,
      profiles: allProfiles(customProfiles),
    }),
  });
}

/** Loads what was learned about the paired bike on earlier rides. */
async function loadBikeKnowledge(): Promise<void> {
  const { bike } = getState();
  const [learnedBike, customProfiles] = await Promise.all([
    bike ? loadLearnedBike(bike.ssid).catch(() => null) : Promise.resolve(null),
    loadCustomProfiles().catch(() => []),
  ]);
  setState({ learnedBike, customProfiles });
  matchBike();
}

/** The rider picks a profile by hand; null returns to automatic. */
export function chooseBikeProfile(id: string | null): void {
  const { bike, learnedBike } = getState();
  if (!bike) return;
  const next = chooseProfile(learnedBike ?? emptyLearned(bike.ssid, Date.now()), id);
  setState({ learnedBike: next });
  void saveLearnedBike(next).catch(() => undefined);
  matchBike();
}

/** Adds a profile someone shared as JSON. Returns an error text, or null when it was added. */
export async function importBikeProfile(text: string): Promise<string | null> {
  const parsed = parseProfileJson(text);
  if (!parsed.ok) return parsed.error;
  await saveCustomProfile(parsed.profile);
  setState({ customProfiles: await loadCustomProfiles() });
  matchBike();
  return null;
}

export function connect(): void {
  void connectAsync();
}

async function connectAsync(): Promise<void> {
  const { bike, settings } = getState();
  if (!bike) return;
  void session?.stop();
  await loadBikeKnowledge();

  const { bikeMatch, learnedBike } = getState();
  const overrides = bikeMatch ? sessionOptionsFor(bikeMatch.profile, learnedBike) : null;
  // An explicit setting wins; "auto" takes what worked before, then the profile, then the safe default.
  const supportFunction =
    settings.supportFunction === 'auto' ? (overrides?.identity.supportFunction ?? 0) : settings.supportFunction;
  const identity = {
    ...DEFAULT_IDENTITY,
    // Brand and model are informational; keep them true to the phone in hand.
    phoneBrand: Platform.OS === 'android' ? 'Android' : 'Apple',
    phoneModel: Platform.OS === 'android' ? 'Android phone' : 'iPhone',
    phoneOs: settings.identityOs,
    phoneType: settings.identityOs,
    supportFunction,
  };
  if (bikeMatch) appendLog(`bike profile: ${bikeMatch.profile.name} (${bikeMatch.confidence}), flag ${supportFunction}`);

  session = new LinkSession(
    nativeTransport,
    {
      onChange: (link) => {
        setState({ link });
        syncLiveActivity();
        // Remember what this dash reports, so the next ride starts from facts.
        const before = getState().learnedBike;
        const learned = learnFromSnapshot(before, {
          ssid: bike.ssid,
          modelId: bike.modelId,
          snapshot: link,
          identity,
          now: Date.now(),
        });
        if (learned && learned !== before) {
          setState({ learnedBike: learned });
          void saveLearnedBike(learned).catch(() => undefined);
          matchBike();
        }
        if (link.state === 'streaming' && previousLinkState !== 'streaming') {
          // The dash reads media-player capabilities once, when Bluetooth connects.
          // Announce again now that it is showing our picture.
          setTimeout(() => void MotoLink.reannounceButtons().catch(() => undefined), 3000);
        }
        previousLinkState = link.state;
      },
      onLog: appendLog,
    },
    { bitrate: settings.bitrateKbps * 1000, identity, dashHost: settings.dashHostOverride.trim() || null },
  );
  session.start(bike);
}

export async function disconnect(): Promise<void> {
  linkExpected = false;
  await session?.stop();
  session = null;
  previousLinkState = 'idle';
  setState({ link: { ...getState().link, state: 'idle' } });
  syncLiveActivity();
}

let lastStrip: NativeStrip | null = null;

/**
 * Refreshes the split-view strip. Called often; sends only when a text
 * changed, so a steady speed costs nothing.
 */
function syncMirrorStrip(): void {
  const state = getState();
  const strip = buildStrip({
    edge: state.settings.mirrorStrip,
    speedKmh: state.metrics.speedKmh,
    tripKm: state.metrics.tripKm,
    imperial: state.settings.units === 'imperial',
    now: new Date(),
    trackTitle: state.spotify.playback?.isPlaying ? state.spotify.playback.title : null,
    alert: state.alert ? { short: state.alert.short, urgent: state.alert.severity === 'urgent' } : null,
  });
  if (sameStrip(lastStrip, strip)) return;
  lastStrip = strip;
  // Not on Android yet: the strip and the lock-screen activity are iOS features so far.
  if (Platform.OS === 'ios') MotoLink.setMirrorStrip(strip);
}

export function setMirrorStrip(edge: StripEdge): void {
  saveSettings({ mirrorStrip: edge });
  syncMirrorStrip();
}

const alertTracker = new AlertTracker();
let fuel = EMPTY_FUEL;
/** The rider started these and has not stopped them; a drop is then worth a warning. */
let linkExpected = false;
let mirroringExpected = false;
let lastThemeCheck = 0;

/**
 * Riding comfort: works out the warnings that apply now, speaks new ones, and
 * follows daylight with the dash theme. Runs on every GPS reading and on link
 * or mirroring changes.
 */
function runComfort(): void {
  const state = getState();
  const comfort = state.settings.comfort;

  // Fuel: turn the trip meter into distance since the last refuel.
  const tracked = trackTrip(fuel, state.metrics.tripKm);
  if (tracked !== fuel) {
    fuel = tracked;
    if (Math.abs(fuel.kmSinceRefuel - comfort.kmSinceRefuel) >= 0.5) {
      saveSettings({ comfort: { ...comfort, kmSinceRefuel: fuel.kmSinceRefuel } });
    }
  }

  const linkUp = state.link.state === 'streaming' || state.link.state === 'negotiated';
  if (linkUp) linkExpected = true;
  const events = alertTracker.update({
    metrics: state.metrics,
    batteryLevel: state.battery.level,
    charging: state.battery.charging,
    linkConnected: linkUp,
    linkExpected,
    mirroring: state.mirroring,
    mirroringExpected,
    lastFixAt: lastSampleAt || null,
    imperial: state.settings.units === 'imperial',
    settings: { ...comfort, kmSinceRefuel: fuel.kmSinceRefuel },
    now: Date.now(),
  });
  for (const event of events) {
    if (event.speak && comfort.voice) say(event.alert.spoken);
  }
  const top = pickStripAlert(alertTracker.active);
  if ((top?.id ?? null) !== (state.alert?.id ?? null) || top?.severity !== state.alert?.severity) {
    setState({ alert: top });
    syncMirrorStrip();
  }

  // Day or night colours, checked once a minute.
  const now = Date.now();
  if (comfort.autoTheme && now - lastThemeCheck > 60_000) {
    lastThemeCheck = now;
    const wanted = themeForTime({
      now: new Date(now),
      latitude: state.metrics.latitude,
      longitude: state.metrics.longitude,
      dayTheme: comfort.dayTheme,
      nightTheme: comfort.nightTheme,
      currentTheme: state.dash.theme,
    });
    if (wanted !== state.dash.theme && (THEMES as readonly string[]).includes(wanted)) {
      setDashTheme(wanted as DashTheme);
    }
  }
}

export function changeComfort(patch: Partial<ComfortSettings>): void {
  saveSettings({ comfort: { ...getState().settings.comfort, ...patch } });
  lastThemeCheck = 0;
  runComfort();
}

/** The rider filled up: the fuel reminder starts counting again. */
export function markRefuelled(): void {
  fuel = refuel(fuel);
  changeComfort({ kmSinceRefuel: 0 });
}

export function testVoice(): void {
  say('Voice announcements are on.', { enabled: true });
}

let activityShown = false;

/**
 * Keeps the lock-screen ride activity in step with the app. Cheap to call
 * often: the native side spaces the updates out.
 */
function syncLiveActivity(): void {
  const state = getState();
  if (!shouldShowActivity(state.link.state, state.mirroring)) {
    if (activityShown && Platform.OS === 'ios') MotoLink.endLiveActivity();
    activityShown = false;
    return;
  }
  if (Platform.OS !== 'ios') return;
  activityShown =
    MotoLink.updateLiveActivity(
      activityState({
        link: state.link.state,
        mirroring: state.mirroring,
        speedKmh: state.metrics.speedKmh,
        tripKm: state.metrics.tripKm,
        imperial: state.settings.units === 'imperial',
        trackTitle: state.spotify.playback?.isPlaying ? state.spotify.playback.title : null,
      }),
    ) || activityShown;
}

/** Set when the bike connected while the app was in the background. */
let pickerDue = false;

function onBluetoothOutputs(current: string[]): void {
  const state = getState();
  const steps = onBluetoothChange({
    bike: state.settings.bikeBluetooth,
    enabled: state.settings.autoStart,
    previous: state.bluetoothOutputs,
    current,
    mirroring: state.mirroring,
    appActive: AppState.currentState === 'active',
  });
  setState({ bluetoothOutputs: current });

  for (const step of steps) {
    if (step === 'connect') {
      appendLog('bike Bluetooth connected');
      if (state.bike && state.link.state === 'idle') connect();
    } else if (step === 'showPicker') {
      toggleMirroring();
    } else {
      pickerDue = true;
      void MotoLink.notify('Bike connected', 'Tap to put your phone screen on the dash.').catch(() => undefined);
    }
  }
}

/** Marks a connected Bluetooth device as the bike, or clears it with null. */
export function setBikeBluetooth(name: string | null): void {
  saveSettings({ bikeBluetooth: name });
  if (name) void MotoLink.requestNotificationPermission().catch(() => undefined);
}

/** Called once when the app starts. */
export async function bootstrap(): Promise<void> {
  await loadPersisted();
  buttonSubscription?.remove();
  logSubscription?.remove();
  buttonSubscription = MotoLink.addListener('onButton', onButton);
  logSubscription = MotoLink.addListener('onLog', (event) => appendLog(event.message));
  mirrorSubscription?.remove();
  mirrorSubscription = MotoLink.addListener('onMirrorState', (event) => {
    setState({ mirroring: event.active });
    // Mirroring that stops without the rider asking is worth a warning.
    if (event.active) mirroringExpected = true;
    runComfort();
    syncLiveActivity();
    appendLog(event.active ? 'screen mirroring started' : 'screen mirroring stopped');
  });
  setState({ mirroring: MotoLink.isMirroring(), bluetoothOutputs: MotoLink.getBluetoothOutputs() });
  routeSubscription?.remove();
  routeSubscription = MotoLink.addListener('onAudioRoute', (event) => onBluetoothOutputs(event.outputs));
  appStateSubscription?.remove();
  appStateSubscription = AppState.addEventListener('change', (next) => {
    if (next !== 'active' || !pickerDue) return;
    pickerDue = false;
    const now = getState();
    // The rider came back from the notification: bring up the Start Broadcast sheet.
    if (!now.mirroring && bikeConnected(now.settings.bikeBluetooth, now.bluetoothOutputs)) toggleMirroring();
  });
  await applyButtonMode();
  applyMirrorView();
  syncMirrorStrip();
  void bootstrapSpotify();
  fuel = { ...EMPTY_FUEL, kmSinceRefuel: getState().settings.comfort.kmSinceRefuel };
  watchBattery((battery) => {
    setState({ battery });
    runComfort();
  });
  void startMetrics();
  void loadBikeKnowledge();
  const { bike, settings } = getState();
  if (bike && settings.autoConnect) connect();
}
