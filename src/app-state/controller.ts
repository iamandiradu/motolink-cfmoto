/**
 * Wires the pieces together: link session, handlebar buttons, dash UI state
 * and metrics. Module-level singletons; the bike has one dash.
 */
import { MotoLink, NativeButtonEvent } from '../../modules/moto-link';
import { Gesture, GestureDetector } from '../buttons/gestures';
import { DashAction, resolveAction } from '../buttons/mapping';
import { dashReducer } from '../dash/controller';
import { nativeTransport } from '../link/nativeTransport';
import { PhoneSensorSource } from '../metrics/phoneSensors';
import { TripComputer } from '../metrics/trip';
import { DEFAULT_IDENTITY } from '../protocol/control';
import { LinkSession, LinkState } from '../protocol/session';
import { appendLog, getState, loadPersisted, setState } from './store';

let session: LinkSession | null = null;
let previousLinkState: LinkState = 'idle';
let buttonSubscription: { remove(): void } | null = null;
let logSubscription: { remove(): void } | null = null;
let mirrorSubscription: { remove(): void } | null = null;

const trip = new TripComputer();
const phoneSensors = new PhoneSensorSource();
let metricsRunning = false;

/** Runs a dash action, whether it came from a handlebar button or the phone screen. */
export function dispatchDashAction(action: DashAction): void {
  const before = getState().dash;
  const after = dashReducer(before, action);
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
    await phoneSensors.start((sample) => setState({ metrics: trip.add(sample) }));
  } catch (error) {
    metricsRunning = false;
    appendLog(`metrics: ${String(error)}`);
  }
}

export function calibrateLean(): void {
  phoneSensors.calibrate();
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
  setState({ mirroring: MotoLink.isMirroring() });
  await applyButtonMode();
  void startMetrics();
  const { bike, settings } = getState();
  if (bike && settings.autoConnect) connect();
}
