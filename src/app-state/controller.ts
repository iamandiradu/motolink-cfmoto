/**
 * Wires the pieces together: link session, handlebar buttons, dash UI state
 * and metrics. Module-level singletons; the bike has one dash.
 */
import { AppState } from 'react-native';

import { MotoLink, NativeButtonEvent } from '../../modules/moto-link';
import { Gesture, GestureDetector } from '../buttons/gestures';
import { DashAction, resolveAction } from '../buttons/mapping';
import { DashPage, DashState, dashReducer, showPage, tapItem } from '../dash/controller';
import { nativeTransport } from '../link/nativeTransport';
import { PhoneSensorSource } from '../metrics/phoneSensors';
import { TripComputer } from '../metrics/trip';
import { DEFAULT_IDENTITY } from '../protocol/control';
import { LinkSession, LinkState } from '../protocol/session';
import { bikeConnected, onBluetoothChange } from './autoStart';
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
    await phoneSensors.start((sample) => {
      lastSampleAt = Date.now();
      setState({ metrics: trip.add(sample) });
    });
    setInterval(() => {
      if (Date.now() - lastSampleAt < GPS_STALE_MS) return;
      const stale = trip.markStale();
      if (stale !== getState().metrics) setState({ metrics: stale });
    }, 2000);
  } catch (error) {
    metricsRunning = false;
    appendLog(`metrics: ${String(error)}`);
  }
}

const FIT_CODE = { auto: 0, fill: 1, fit: 2 } as const;

/** Sends the saved crop, zoom and fit to the broadcast extension. */
export function applyMirrorView(): void {
  const view = getState().settings.mirrorView;
  MotoLink.setMirrorView({
    zoom: view.zoom * 10,
    trimTop: view.trimTop * 10,
    trimBottom: view.trimBottom * 10,
    trimLeft: view.trimLeft * 10,
    trimRight: view.trimRight * 10,
    fit: FIT_CODE[view.fit],
  });
}

/** Opens the iOS sheet that starts or stops mirroring the phone screen. */
export function toggleMirroring(): void {
  void MotoLink.showBroadcastPicker().catch((error) => appendLog(`mirroring: ${String(error)}`));
}

export function connect(): void {
  const { bike, settings } = getState();
  if (!bike) return;
  void session?.stop();
  session = new LinkSession(
    nativeTransport,
    {
      onChange: (link) => {
        setState({ link });
        if (link.state === 'streaming' && previousLinkState !== 'streaming') {
          // The dash reads media-player capabilities once, when Bluetooth connects.
          // Announce again now that it is showing our picture.
          setTimeout(() => void MotoLink.reannounceButtons().catch(() => undefined), 3000);
        }
        previousLinkState = link.state;
      },
      onLog: appendLog,
    },
    {
      bitrate: settings.bitrateKbps * 1000,
      identity: {
        ...DEFAULT_IDENTITY,
        phoneOs: settings.identityOs,
        phoneType: settings.identityOs,
        supportFunction: settings.supportFunction,
      },
    },
  );
  session.start(bike);
}

export async function disconnect(): Promise<void> {
  await session?.stop();
  session = null;
  previousLinkState = 'idle';
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
  void startMetrics();
  const { bike, settings } = getState();
  if (bike && settings.autoConnect) connect();
}
