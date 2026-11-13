/**
 * Button layout: which action each handlebar gesture triggers on the dash UI.
 * A default layout ships with the app; every gesture can be remapped.
 */
import { t } from '../i18n';
import { GESTURES, Gesture } from './gestures';

export const ACTIONS = [
  'none',
  'focusNext',
  'focusPrevious',
  'select',
  'back',
  'home',
  'pageNext',
  'pagePrevious',
  'zoomIn',
  'zoomOut',
  'toggleTheme',
  'resetTrip',
  'musicPlayPause',
  'musicNext',
  'musicPrevious',
] as const;

export type DashAction = (typeof ACTIONS)[number];

/** Name of an action in the current language; a function so it follows a language change. */
export function actionLabel(action: DashAction): string {
  return t(`actions.${action}`);
}

export type ButtonLayout = Record<Gesture, DashAction>;

/**
 * Default layout. Up/down walk the focus, select activates, the double taps
 * give the two actions a rocker-plus-enter pod has no key for.
 */
export const DEFAULT_LAYOUT: Readonly<ButtonLayout> = Object.freeze({
  upPress: 'focusPrevious',
  upDouble: 'home',
  downPress: 'focusNext',
  downDouble: 'back',
  selectPress: 'select',
  nextPress: 'pageNext',
  nextDouble: 'none',
  previousPress: 'pagePrevious',
  previousDouble: 'none',
});

function isAction(value: unknown): value is DashAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

/** Reads a stored layout. Unknown or missing entries fall back to the default. */
export function normaliseLayout(stored: unknown): ButtonLayout {
  const source = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const layout = { ...DEFAULT_LAYOUT };
  for (const gesture of GESTURES) {
    const value = source[gesture];
    if (isAction(value)) layout[gesture] = value;
  }
  return layout;
}

export function setMapping(layout: ButtonLayout, gesture: Gesture, action: DashAction): ButtonLayout {
  return { ...layout, [gesture]: action };
}

export function resolveAction(layout: ButtonLayout, gesture: Gesture): DashAction {
  return layout[gesture] ?? 'none';
}

export function isDefaultLayout(layout: ButtonLayout): boolean {
  return GESTURES.every((gesture) => layout[gesture] === DEFAULT_LAYOUT[gesture]);
}
