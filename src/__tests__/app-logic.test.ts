import { Gesture, GestureDetector } from '../buttons/gestures';
import { DEFAULT_LAYOUT, isDefaultLayout, normaliseLayout, resolveAction, setMapping } from '../buttons/mapping';
import { INITIAL_DASH_STATE, dashReducer, showPage, tapItem } from '../dash/controller';
import { TripComputer, compassPoint, formatClock, formatDuration, gpsQuality, haversineM } from '../metrics/trip';

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
    expect(run('pageNext', 'focusNext', 'pageNext').focus).toBe(0);
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
    expect(run('pagePrevious', 'focusPrevious', 'select').theme).toBe('day');
    expect(run('pageNext', 'pageNext', 'select').tripResetToken).toBe(1);
  });

  it('back opens the menu, home returns to the ride page', () => {
    expect(run('pageNext', 'back').page).toBe('menu');
    expect(run('pageNext', 'back', 'back').page).toBe('ride');
    expect(run('pageNext', 'home').page).toBe('ride');
  });

  it('handles taps from the phone preview', () => {
    expect(showPage(INITIAL_DASH_STATE, 'trip')).toMatchObject({ page: 'trip', focus: 0 });
    // Ride page: its one item is the Map button.
    expect(tapItem(INITIAL_DASH_STATE, 0).page).toBe('map');
    // Map page: second item zooms out, and takes the focus ring with it.
    expect(tapItem(showPage(INITIAL_DASH_STATE, 'map'), 1)).toMatchObject({ zoom: 14, focus: 1 });
    expect(tapItem(INITIAL_DASH_STATE, 7)).toBe(INITIAL_DASH_STATE);
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
