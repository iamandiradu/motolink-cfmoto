import { onBluetoothChange } from '../app-state/autoStart';
import { activityLink, activityState, shouldShowActivity } from '../app-state/liveActivity';
import { Gesture, GestureDetector } from '../buttons/gestures';
import { DEFAULT_LAYOUT, isDefaultLayout, normaliseLayout, resolveAction, setMapping } from '../buttons/mapping';
import { INITIAL_DASH_STATE, dashReducer, showPage, tapItem } from '../dash/controller';
import { LeanEstimator, MotionSample, turnRateAroundVertical } from '../metrics/lean';
import {
  TripComputer,
  compassPoint,
  estimateLeanDeg,
  formatClock,
  formatDuration,
  gpsQuality,
  haversineM,
} from '../metrics/trip';

describe('auto-start on bike Bluetooth', () => {
  const base = {
    bike: 'CFMOTO-BT',
    enabled: true,
    previous: [] as string[],
    current: ['CFMOTO-BT'],
    mirroring: false,
    appActive: true,
  };

  it('opens the broadcast sheet when the bike connects and the app is in front', () => {
    expect(onBluetoothChange(base)).toEqual(['connect', 'showPicker']);
  });

  it('notifies instead when the app is in the background', () => {
    expect(onBluetoothChange({ ...base, appActive: false })).toEqual(['connect', 'notify']);
  });

  it('does not ask again while already mirroring', () => {
    expect(onBluetoothChange({ ...base, mirroring: true })).toEqual(['connect']);
  });

  it('reacts only to the bike appearing, not to other devices or repeats', () => {
    expect(onBluetoothChange({ ...base, current: ['Helmet'] })).toEqual([]);
    expect(onBluetoothChange({ ...base, previous: ['CFMOTO-BT'], current: ['CFMOTO-BT', 'Helmet'] })).toEqual([]);
    expect(onBluetoothChange({ ...base, previous: ['CFMOTO-BT'], current: [] })).toEqual([]);
  });

  it('stays quiet when switched off or no bike is chosen', () => {
    expect(onBluetoothChange({ ...base, enabled: false })).toEqual([]);
    expect(onBluetoothChange({ ...base, bike: null })).toEqual([]);
  });
});

describe('lock-screen ride activity', () => {
  it('maps link states to the four the activity shows', () => {
    expect(activityLink('idle')).toBe('off');
    expect(activityLink('searching')).toBe('searching');
    expect(activityLink('handshaking')).toBe('connecting');
    expect(activityLink('streaming')).toBe('onDash');
  });

  it('formats speed and trip in the chosen units', () => {
    const base = { link: 'streaming' as const, mirroring: true, speedKmh: 100, tripKm: 10, trackTitle: null };
    expect(activityState({ ...base, imperial: false })).toMatchObject({ speed: 100, speedUnit: 'km/h', tripText: '10.0 km' });
    expect(activityState({ ...base, imperial: true })).toMatchObject({ speed: 62, speedUnit: 'mph', tripText: '6.2 mi' });
    expect(activityState({ ...base, speedKmh: null, imperial: false }).speed).toBeNull();
  });

  it('shows while connecting or mirroring, and not when idle', () => {
    expect(shouldShowActivity('idle', false)).toBe(false);
    expect(shouldShowActivity('searching', false)).toBe(true);
    expect(shouldShowActivity('idle', true)).toBe(true);
  });
});

describe('GestureDetector', () => {
  function setup(wantsDouble = false) {
    const out: Gesture[] = [];
    let now = 0;
    const timers: { at: number; fn: () => void; live: boolean }[] = [];
    const detector = new GestureDetector((g) => out.push(g), {
      wantsDouble: () => wantsDouble,
      now: () => now,
      schedule: (fn, ms) => {
        const timer = { at: now + ms, fn, live: true };
        timers.push(timer);
        return timer;
      },
      cancel: (handle) => {
        (handle as { live: boolean }).live = false;
      },
    });
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers) if (t.live && t.at <= now) (t.live = false), t.fn();
    };
    return { out, detector, advance };
  }

  it('reads the volume rocker by direction and jump size', () => {
    const { out, detector } = setup();
    detector.handle({ type: 'volume', delta: 0.0625 });
    detector.handle({ type: 'volume', delta: -0.0625 });
    detector.handle({ type: 'volume', delta: 0.1875 });
    detector.handle({ type: 'volume', delta: -0.125 });
    expect(out).toEqual(['upPress', 'downPress', 'upDouble', 'downDouble']);
  });

  it('ignores volume jumps that are not a button', () => {
    const { out, detector } = setup();
    detector.handle({ type: 'volume', delta: -0.5 }); // Bluetooth drop slams volume
    detector.handle({ type: 'volume', delta: 0.005 });
    expect(out).toEqual([]);
  });

  it('debounces select', () => {
    const { out, detector, advance } = setup();
    detector.handle({ type: 'key', key: 'playPause' });
    advance(50);
    detector.handle({ type: 'key', key: 'playPause' });
    advance(200);
    detector.handle({ type: 'key', key: 'playPause' });
    expect(out).toEqual(['selectPress', 'selectPress']);
  });

  it('fires track keys at once when no double gesture is mapped', () => {
    const { out, detector } = setup(false);
    detector.handle({ type: 'key', key: 'next' });
    detector.handle({ type: 'key', key: 'next' });
    expect(out).toEqual(['nextPress', 'nextPress']);
  });

  it('detects a double tap inside the window when one is mapped', () => {
    const { out, detector, advance } = setup(true);
    detector.handle({ type: 'key', key: 'next' });
    advance(230);
    detector.handle({ type: 'key', key: 'next' });
    expect(out).toEqual(['nextDouble']);

    detector.handle({ type: 'key', key: 'previous' });
    advance(400);
    expect(out).toEqual(['nextDouble', 'previousPress']);
  });

  it('does not merge different keys into a double', () => {
    const { out, detector, advance } = setup(true);
    detector.handle({ type: 'key', key: 'next' });
    advance(100);
    detector.handle({ type: 'key', key: 'previous' });
    advance(400);
    expect(out).toEqual(['nextPress', 'previousPress']);
  });
});

describe('button layout', () => {
  it('has a default for every gesture', () => {
    expect(resolveAction(DEFAULT_LAYOUT, 'downPress')).toBe('focusNext');
    expect(resolveAction(DEFAULT_LAYOUT, 'selectPress')).toBe('select');
    expect(isDefaultLayout(normaliseLayout(null))).toBe(true);
  });

  it('remaps one gesture and survives a storage round trip', () => {
    const custom = setMapping({ ...DEFAULT_LAYOUT }, 'upDouble', 'zoomIn');
    const restored = normaliseLayout(JSON.parse(JSON.stringify(custom)));
    expect(restored.upDouble).toBe('zoomIn');
    expect(restored.downPress).toBe('focusNext');
    expect(isDefaultLayout(restored)).toBe(false);
  });

  it('drops unknown stored actions', () => {
    expect(normaliseLayout({ upPress: 'launchMissiles', bogus: 'select' }).upPress).toBe('focusPrevious');
  });
});

describe('dash controller', () => {
  const run = (...actions: Parameters<typeof dashReducer>[1][]) =>
    actions.reduce(dashReducer, INITIAL_DASH_STATE);

  it('cycles pages and resets focus', () => {
    expect(run('pageNext').page).toBe('map');
    expect(run('pagePrevious').page).toBe('menu');
    expect(run('pageNext', 'focusNext', 'pagePrevious').focus).toBe(0);
  });

  it('wraps focus within a page', () => {
    const map = run('pageNext');
    expect(dashReducer(map, 'focusPrevious').focus).toBe(2);
    expect(run('pageNext', 'focusNext', 'focusNext', 'focusNext').focus).toBe(0);
  });

  it('activates the focused item', () => {
    expect(run('pageNext', 'select').zoom).toBe(16);
    expect(run('pageNext', 'focusNext', 'select').zoom).toBe(14);
    expect(run('pagePrevious', 'focusNext', 'select').page).toBe('map');
    // Menu: the last item steps through the colour themes.
    expect(run('pagePrevious', 'focusPrevious', 'select').theme).toBe('gray');
    expect(run('pageNext', 'pageNext', 'pageNext', 'select').tripResetToken).toBe(1);
  });

  it('back opens the menu, home returns to the ride page', () => {
    expect(run('pageNext', 'back').page).toBe('menu');
    expect(run('pageNext', 'back', 'back').page).toBe('ride');
    expect(run('pageNext', 'home').page).toBe('ride');
  });

  it('handles taps from the phone preview', () => {
    expect(showPage(INITIAL_DASH_STATE, 'trip')).toMatchObject({ page: 'trip', focus: 0 });
    expect(showPage(INITIAL_DASH_STATE, 'music')).toMatchObject({ page: 'music', focus: 1 });
    // Ride page: its one item is the Map button.
    expect(tapItem(INITIAL_DASH_STATE, 0).page).toBe('map');
    // Map page: second item zooms out, and takes the focus ring with it.
    expect(tapItem(showPage(INITIAL_DASH_STATE, 'map'), 1)).toMatchObject({ zoom: 14, focus: 1 });
    expect(tapItem(INITIAL_DASH_STATE, 7)).toBe(INITIAL_DASH_STATE);
  });

  it('cycles the colour themes and comes back', () => {
    let state = INITIAL_DASH_STATE;
    const seen = [state.theme];
    for (let i = 0; i < 5; i++) seen.push((state = dashReducer(state, 'toggleTheme')).theme);
    expect(seen).toEqual(['aurora', 'gray', 'graphite', 'neon', 'day', 'aurora']);
  });

  it('turns music controls into numbered requests', () => {
    // The Music page opens on play/pause.
    const playing = run('pageNext', 'pageNext', 'select');
    expect(playing).toMatchObject({ page: 'music', music: { id: 1, request: 'toggle' } });
    expect(dashReducer(playing, 'focusNext').focus).toBe(2);
    const skipped = dashReducer(dashReducer(playing, 'focusNext'), 'select');
    expect(skipped.music).toEqual({ id: 2, request: 'next' });
    // A handlebar button mapped to a music action works from any page.
    expect(dashReducer(INITIAL_DASH_STATE, 'musicPrevious').music).toEqual({ id: 1, request: 'previous' });
  });

  it('clamps zoom', () => {
    let state = INITIAL_DASH_STATE;
    for (let i = 0; i < 30; i++) state = dashReducer(state, 'zoomIn');
    expect(state.zoom).toBe(19);
  });
});

describe('trip computer', () => {
  it('measures distance', () => {
    // One degree of latitude is about 111.2 km.
    expect(haversineM(45, 25, 46, 25) / 1000).toBeCloseTo(111.2, 0);
  });

  it('accumulates distance and time only while moving', () => {
    const trip = new TripComputer();
    const step = 0.0001; // about 11.1 m of latitude
    trip.add({ timestamp: 0, latitude: 45, longitude: 25, speedKmh: 40, accuracyM: 5 });
    trip.add({ timestamp: 1000, latitude: 45 + step, longitude: 25, speedKmh: 40, accuracyM: 5 });
    trip.add({ timestamp: 2000, latitude: 45 + 2 * step, longitude: 25, speedKmh: 40, accuracyM: 5 });
    // Stopped at a light: GPS drifts, nothing is added.
    trip.add({ timestamp: 3000, latitude: 45 + 2.5 * step, longitude: 25, speedKmh: 0.5, accuracyM: 5 });
    const m = trip.get();
    expect(m.tripKm * 1000).toBeCloseTo(22.2, 0);
    expect(m.movingSeconds).toBe(2);
    expect(m.maxSpeedKmh).toBe(40);
    expect(m.avgSpeedKmh).toBeCloseTo(40, 0);
  });

  it('skips poor fixes and long gaps', () => {
    const trip = new TripComputer();
    trip.add({ timestamp: 0, latitude: 45, longitude: 25, speedKmh: 50, accuracyM: 5 });
    trip.add({ timestamp: 1000, latitude: 45.01, longitude: 25, speedKmh: 50, accuracyM: 500 });
    trip.add({ timestamp: 60_000, latitude: 45.02, longitude: 25, speedKmh: 50, accuracyM: 5 });
    expect(trip.get().tripKm).toBe(0);
  });

  it('reads zero and holds the last direction while stopped', () => {
    const trip = new TripComputer();
    trip.add({ timestamp: 0, latitude: 45, longitude: 25, speedKmh: 60, headingDeg: 90, accuracyM: 5 });
    // At a light: GPS speed wanders and course spins.
    trip.add({ timestamp: 1000, latitude: 45, longitude: 25, speedKmh: 1.4, headingDeg: 251, accuracyM: 5 });
    expect(trip.get()).toMatchObject({ speedKmh: 0, headingDeg: 90, maxSpeedKmh: 60 });
  });

  it('reset clears the trip but keeps the live reading', () => {
    const trip = new TripComputer();
    trip.add({ timestamp: 0, latitude: 45, longitude: 25, speedKmh: 40, accuracyM: 5 });
    trip.add({ timestamp: 1000, latitude: 45.0001, longitude: 25, speedKmh: 40, accuracyM: 5 });
    const after = trip.resetTrip();
    expect(after).toMatchObject({ tripKm: 0, movingSeconds: 0, maxSpeedKmh: 0, avgSpeedKmh: 0, speedKmh: 40 });
  });

  it('blanks the live speed when GPS goes quiet, and keeps the trip', () => {
    const trip = new TripComputer();
    trip.add({ timestamp: 0, latitude: 45, longitude: 25, speedKmh: 72, accuracyM: 5 });
    trip.add({ timestamp: 1000, latitude: 45.0002, longitude: 25, speedKmh: 72, accuracyM: 5 });
    const km = trip.get().tripKm;
    const stale = trip.markStale();
    expect(stale).toMatchObject({ speedKmh: null, accuracyM: null, tripKm: km, maxSpeedKmh: 72 });
    expect(trip.markStale()).toBe(stale);
  });

  describe('lean estimate', () => {
    it('matches the physics of a steady turn', () => {
      // 72 km/h (20 m/s) turning 11.46 deg/s (0.2 rad/s): atan(20 * 0.2 / 9.81) = 22.2 deg.
      expect(estimateLeanDeg(72, 90, 101.46, 1)).toBeCloseTo(22.2, 1);
      expect(estimateLeanDeg(72, 90, 78.54, 1)).toBeCloseTo(-22.2, 1);
    });

    it('takes the short way round north', () => {
      expect(estimateLeanDeg(72, 355, 5, 1)).toBeCloseTo(estimateLeanDeg(72, 10, 20, 1)!, 5);
    });

    it('gives no estimate when slow, after a gap, or for an impossible jump', () => {
      expect(estimateLeanDeg(10, 90, 120, 1)).toBeNull();
      expect(estimateLeanDeg(72, 90, 100, 8)).toBeNull();
      expect(estimateLeanDeg(120, 0, 170, 1)).toBeNull();
    });

    it('is tracked through a corner, peaks in max lean, and returns upright when stopped', () => {
      const trip = new TripComputer();
      let heading = 90;
      for (let t = 0; t <= 5; t++) {
        trip.add({ timestamp: t * 1000, latitude: 45 + t * 0.0002, longitude: 25, speedKmh: 72, headingDeg: heading, accuracyM: 5 });
        heading += 11.46;
      }
      const cornering = trip.get();
      expect(cornering.leanDeg).toBeGreaterThan(20);
      expect(cornering.leanDeg).toBeLessThan(23);
      expect(cornering.maxLeanDeg).toBeCloseTo(cornering.leanDeg!, 5);

      trip.add({ timestamp: 6000, latitude: 45.0012, longitude: 25, speedKmh: 0, headingDeg: 200, accuracyM: 5 });
      expect(trip.get().leanDeg).toBe(0);
      expect(trip.get().maxLeanDeg).toBeGreaterThan(20);
      expect(trip.resetTrip().maxLeanDeg).toBe(0);
    });
  });

  describe('lean with motion sensors', () => {
    // Phone lying at an arbitrary angle: "down" is along (1, 2, 2) / 3.
    const down = { x: 1 / 3, y: 2 / 3, z: 2 / 3 };
    const turning = (rate: number, t: number): MotionSample => ({
      timestamp: t,
      // A turn around the vertical at `rate` deg/s, expressed in the phone's axes.
      rotationRate: { x: down.x * rate, y: down.y * rate, z: down.z * rate },
      gravity: { x: down.x * 9.81, y: down.y * 9.81, z: down.z * 9.81 },
    });

    it('finds the turn rate whichever way the phone lies', () => {
      expect(turnRateAroundVertical(turning(11.46, 0))).toBeCloseTo(11.46, 3);
      // Rotation about a horizontal axis (the phone tumbling in a pocket) is not a turn.
      const tumble: MotionSample = { timestamp: 0, rotationRate: { x: 2, y: -1, z: 0 }, gravity: turning(0, 0).gravity };
      expect(turnRateAroundVertical(tumble)).toBeCloseTo(0, 6);
      expect(turnRateAroundVertical({ ...tumble, gravity: { x: 0, y: 0, z: 0 } })).toBeNull();
    });

    it('takes the size from motion and the side from GPS', () => {
      const lean = new LeanEstimator();
      lean.gps(0, 72, 90);
      lean.gps(1000, 72, 80); // turning left
      for (let i = 0; i < 40; i++) lean.motion(turning(11.46, 1000 + i * 100));
      // 72 km/h at 11.46 deg/s is 22.2 degrees; left is negative.
      expect(lean.get()).toBeCloseTo(-22.2, 0);
    });

    it('reads upright when slow, however the phone moves', () => {
      const lean = new LeanEstimator();
      lean.gps(0, 8, 90);
      lean.motion(turning(60, 100));
      expect(lean.get()).toBe(0);
    });

    it('does not guess a side before GPS has seen the turn', () => {
      const lean = new LeanEstimator();
      lean.gps(0, 72, 90);
      lean.motion(turning(11.46, 100));
      expect(lean.get()).toBe(0);
    });

    it('falls back to GPS alone when motion data stops', () => {
      const lean = new LeanEstimator();
      lean.gps(0, 72, 90);
      lean.motion(turning(11.46, 100));
      // Two seconds later, no motion readings since: GPS drives the estimate.
      lean.gps(2000, 72, 90);
      lean.gps(3000, 72, 101.46);
      expect(lean.get()).toBeGreaterThan(10);
    });
  });

  it('rates the GPS signal', () => {
    expect(gpsQuality(null)).toBe('none');
    expect(gpsQuality(8)).toBe('good');
    expect(gpsQuality(65)).toBe('poor');
  });

  it('formats', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(225)).toBe('SW');
    expect(compassPoint(359)).toBe('N');
    expect(formatDuration(75)).toBe('01:15');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatClock(new Date(2026, 10, 13, 7, 5))).toBe('07:05');
  });
});
