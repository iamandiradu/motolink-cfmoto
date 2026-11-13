/**
 * State of the picture shown on the motorcycle dash. The dash has no touch
 * screen, so everything is reached by moving a focus ring with the handlebar
 * buttons. Pure reducer; the React layer renders it.
 */
import type { DashAction } from '../buttons/mapping';

export const PAGES = ['ride', 'map', 'trip', 'menu'] as const;
export type DashPage = (typeof PAGES)[number];

export const PAGE_TITLES: Record<DashPage, string> = {
  ride: 'Ride',
  map: 'Map',
  trip: 'Trip',
  menu: 'Menu',
};

/** Focusable items per page, in focus order. */
export const PAGE_ITEMS: Record<DashPage, readonly string[]> = {
  ride: ['nextPage'],
  map: ['zoomIn', 'zoomOut', 'recenter'],
  trip: ['resetTrip'],
  menu: ['ride', 'map', 'trip', 'theme'],
};

export type DashTheme = 'day' | 'night';

export interface DashState {
  page: DashPage;
  focus: number;
  theme: DashTheme;
  /** Map zoom level, 3 (far) .. 19 (near). */
  zoom: number;
  /** Map follows the rider. */
  following: boolean;
  /** Bumped when the trip must be cleared; the metrics store watches it. */
  tripResetToken: number;
}

export const INITIAL_DASH_STATE: DashState = {
  page: 'ride',
  focus: 0,
  theme: 'night',
  zoom: 15,
  following: true,
  tripResetToken: 0,
};

const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

function goTo(state: DashState, page: DashPage): DashState {
  return state.page === page ? state : { ...state, page, focus: 0 };
}

function shiftPage(state: DashState, step: number): DashState {
  const index = (PAGES.indexOf(state.page) + step + PAGES.length) % PAGES.length;
  return goTo(state, PAGES[index]);
}

function shiftFocus(state: DashState, step: number): DashState {
  const count = PAGE_ITEMS[state.page].length;
  if (count === 0) return state;
  return { ...state, focus: (state.focus + step + count) % count };
}

function zoom(state: DashState, step: number): DashState {
  return { ...state, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom + step)) };
}

function toggleTheme(state: DashState): DashState {
  return { ...state, theme: state.theme === 'day' ? 'night' : 'day' };
}

function activate(state: DashState): DashState {
  const item = PAGE_ITEMS[state.page][state.focus];
  switch (item) {
    case 'nextPage':
      return shiftPage(state, 1);
    case 'zoomIn':
      return zoom(state, 1);
    case 'zoomOut':
      return zoom(state, -1);
    case 'recenter':
      return { ...state, following: true };
    case 'resetTrip':
      return { ...state, tripResetToken: state.tripResetToken + 1 };
    case 'ride':
    case 'map':
    case 'trip':
      return goTo(state, item);
    case 'theme':
      return toggleTheme(state);
    default:
      return state;
  }
}

/** Jumps straight to a page. Used by taps on the phone preview. */
export function showPage(state: DashState, page: DashPage): DashState {
  return goTo(state, page);
}

/** Focuses one item of the current page and activates it, as a tap does. */
export function tapItem(state: DashState, index: number): DashState {
  if (index < 0 || index >= PAGE_ITEMS[state.page].length) return state;
  return activate({ ...state, focus: index });
}

export function dashReducer(state: DashState, action: DashAction): DashState {
  switch (action) {
    case 'focusNext':
      return shiftFocus(state, 1);
    case 'focusPrevious':
      return shiftFocus(state, -1);
    case 'select':
      return activate(state);
    case 'back':
      return state.page === 'menu' ? goTo(state, 'ride') : goTo(state, 'menu');
    case 'home':
      return goTo(state, 'ride');
    case 'pageNext':
      return shiftPage(state, 1);
    case 'pagePrevious':
      return shiftPage(state, -1);
    case 'zoomIn':
      return zoom(state, 1);
    case 'zoomOut':
      return zoom(state, -1);
    case 'toggleTheme':
      return toggleTheme(state);
    case 'resetTrip':
      return { ...state, tripResetToken: state.tripResetToken + 1 };
    case 'none':
    default:
      return state;
  }
}
