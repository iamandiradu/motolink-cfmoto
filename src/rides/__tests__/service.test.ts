import {
  addDistance,
  addRide,
  defaultServiceState,
  dueItems,
  markDone,
  parseServiceState,
  serviceStatuses,
  setOdometer,
  setServiceInterval,
} from '../service';

const item = (s: ReturnType<typeof defaultServiceState>, id: string) => serviceStatuses(s).find((i) => i.id === id)!;

describe('service reminders', () => {
  it('starts with the generic defaults at zero', () => {
    const s = defaultServiceState();
    expect(s.items.map((i) => [i.id, i.intervalKm])).toEqual([
      ['chain-lube', 500],
      ['chain-adjust', 1000],
      ['oil', 6000],
    ]);
    expect(serviceStatuses(s).every((i) => i.status === 'ok' && i.kmSinceDone === 0)).toBe(true);
  });

  it('accumulates ride and manual distance', () => {
    let s = defaultServiceState();
    s = addRide(s, 'r1', 120_000);
    s = addDistance(s, 80);
    expect(item(s, 'chain-lube').kmSinceDone).toBe(200);
    expect(item(s, 'oil').kmSinceDone).toBe(200);
  });

  it('counts a ride only once', () => {
    let s = defaultServiceState();
    s = addRide(s, 'r1', 100_000);
    s = addRide(s, 'r1', 100_000);
    expect(item(s, 'oil').kmSinceDone).toBe(100);
  });

  it('ignores invalid distances', () => {
    const s = defaultServiceState();
    expect(addDistance(s, -5)).toBe(s);
    expect(addDistance(s, NaN)).toBe(s);
    expect(addDistance(s, 0)).toBe(s);
    expect(addDistance(s, 1e9)).toBe(s);
  });

  it('is ok below 85 %, soon from 85 %, due from 100 %', () => {
    const s = defaultServiceState();
    expect(item(addDistance(s, 424), 'chain-lube').status).toBe('ok');
    expect(item(addDistance(s, 425), 'chain-lube').status).toBe('soon');
    expect(item(addDistance(s, 499), 'chain-lube').status).toBe('soon');
    const due = item(addDistance(s, 500), 'chain-lube');
    expect(due.status).toBe('due');
    expect(due.remainingKm).toBe(0);
    expect(item(addDistance(s, 650), 'chain-lube').remainingKm).toBe(-150);
  });

  it('sorts dueItems most urgent first', () => {
    const s = addDistance(defaultServiceState(), 900);
    expect(dueItems(s).map((i) => [i.id, i.status])).toEqual([
      ['chain-lube', 'due'],
      ['chain-adjust', 'soon'],
      ['oil', 'ok'],
    ]);
  });

  it('resets one item on Done', () => {
    let s = addDistance(defaultServiceState(), 700);
    s = markDone(s, 'chain-lube');
    expect(item(s, 'chain-lube').kmSinceDone).toBe(0);
    expect(item(s, 'chain-adjust').kmSinceDone).toBe(700);
  });

  it('edits intervals within limits', () => {
    let s = addDistance(defaultServiceState(), 700);
    s = setServiceInterval(s, 'chain-lube', 800);
    expect(item(s, 'chain-lube')).toMatchObject({ intervalKm: 800, status: 'soon' });
    expect(item(setServiceInterval(s, 'oil', 5), 'oil').intervalKm).toBe(100);
    expect(item(setServiceInterval(s, 'oil', 1e9), 'oil').intervalKm).toBe(100_000);
    expect(setServiceInterval(s, 'oil', NaN)).toBe(s);
  });

  it('uses the first odometer reading as a baseline and adds later increases', () => {
    let s = setOdometer(defaultServiceState(), 12_000);
    expect(s.odometerKm).toBe(12_000);
    expect(item(s, 'oil').kmSinceDone).toBe(0);
    s = addRide(s, 'r1', 100_000);
    expect(s.odometerKm).toBe(12_100);
    s = setOdometer(s, 12_400);
    expect(item(s, 'oil').kmSinceDone).toBe(400);
    // A lower reading is a correction, not negative riding.
    s = setOdometer(s, 12_300);
    expect(s.odometerKm).toBe(12_300);
    expect(item(s, 'oil').kmSinceDone).toBe(400);
  });

  it('reads stored state defensively', () => {
    expect(parseServiceState(null)).toEqual(defaultServiceState());
    expect(parseServiceState({ items: 'x' }).items).toHaveLength(3);
    const s = parseServiceState({
      items: [
        { id: 'oil', name: 'Oil', intervalKm: 5000, kmSinceDone: 10 },
        { id: 'bad', name: 'Bad', intervalKm: -1, kmSinceDone: 0 },
      ],
      odometerKm: 'x',
      countedRideIds: ['a', 3],
    });
    expect(s.items).toEqual([{ id: 'oil', name: 'Oil', intervalKm: 5000, kmSinceDone: 10 }]);
    expect(s.odometerKm).toBeNull();
    expect(s.countedRideIds).toEqual(['a']);
  });
});
