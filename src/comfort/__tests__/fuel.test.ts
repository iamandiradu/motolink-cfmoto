import { addDistance, EMPTY_FUEL, percentUsed, refuel, remainingKm, trackTrip } from '../fuel';

describe('fuel', () => {
  it('adds distance and ignores bad or huge steps', () => {
    let s = addDistance(EMPTY_FUEL, 12.5);
    s = addDistance(s, -3);
    s = addDistance(s, NaN);
    s = addDistance(s, 500);
    expect(s.kmSinceRefuel).toBe(12.5);
  });

  it('turns the trip meter into distance and survives a trip reset', () => {
    let s = trackTrip(EMPTY_FUEL, 100); // first reading only anchors
    expect(s.kmSinceRefuel).toBe(0);
    s = trackTrip(s, 110);
    s = trackTrip(s, 125);
    expect(s.kmSinceRefuel).toBe(25);
    s = trackTrip(s, 0); // trip reset
    s = trackTrip(s, 5);
    expect(s.kmSinceRefuel).toBe(30);
  });

  it('refuel resets the distance and keeps counting from there', () => {
    let s = trackTrip(trackTrip(EMPTY_FUEL, 0), 40);
    s = refuel(s);
    expect(s.kmSinceRefuel).toBe(0);
    s = trackTrip(s, 50);
    expect(s.kmSinceRefuel).toBe(10);
  });

  it('remaining range and percent used', () => {
    const s = { kmSinceRefuel: 200, lastTripKm: null };
    expect(remainingKm(s, 250)).toBe(50);
    expect(percentUsed(s, 250)).toBe(80);
    expect(remainingKm({ ...s, kmSinceRefuel: 300 }, 250)).toBe(0);
    expect(percentUsed({ ...s, kmSinceRefuel: 300 }, 250)).toBe(120);
    expect(remainingKm(s, null)).toBeNull();
    expect(percentUsed(s, null)).toBeNull();
  });
});
