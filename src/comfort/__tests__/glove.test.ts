import { GLOVE_SCALE, gloveScale, NORMAL_SCALE } from '../glove';

describe('gloveScale', () => {
  it('follows the mode and the connection', () => {
    expect(gloveScale('off', true)).toBe(NORMAL_SCALE);
    expect(gloveScale('on', false)).toBe(GLOVE_SCALE);
    expect(gloveScale('whenConnected', true)).toBe(GLOVE_SCALE);
    expect(gloveScale('whenConnected', false)).toBe(NORMAL_SCALE);
  });

  it('keeps touch targets at 44 pt or more, bigger with gloves', () => {
    expect(NORMAL_SCALE.minTouch).toBeGreaterThanOrEqual(44);
    expect(GLOVE_SCALE.minTouch).toBeGreaterThan(NORMAL_SCALE.minTouch);
    expect(GLOVE_SCALE.fontBump).toBeGreaterThan(0);
    expect(GLOVE_SCALE.hideSecondaryText).toBe(true);
    expect(NORMAL_SCALE.hideSecondaryText).toBe(false);
  });
});
