/**
 * State of the picture shown on the motorcycle dash. The dash has no touch
 * screen, so everything is reached by moving a focus ring with the handlebar
 * buttons. Pure reducer; the React layer renders it.
 */
import type { DashAction } from '../buttons/mapping';
import { t } from '../i18n';

export const PAGES = ['ride', 'map', 'music', 'trip', 'menu'] as const;
export type DashPage = (typeof PAGES)[number];

/** Tab title of a page in the current language; read at render time so it follows a change. */
export function pageTitle(page: DashPage): string {
  return t(`dash.pages.${page}`);
}

/** Focusable items per page, in focus order. */
export const PAGE_ITEMS: Record<DashPage, readonly string[]> = {
  ride: ['nextPage'],
  map: ['zoomIn', 'zoomOut', 'recenter'],
  music: ['musicPrevious', 'musicPlayPause', 'musicNext'],
  trip: ['resetTrip'],
  menu: ['ride', 'map', 'music', 'trip', 'theme'],
};

/** Colour themes, after the CFMOTO liveries. */
export const THEMES = ['aurora', 'gray', 'graphite', 'neon', 'day'] as const;
export type DashTheme = (typeof THEMES)[number];

export function themeLabel(theme: DashTheme): string {
  return t(`dash.themes.${theme}`);
}

export type MusicRequest = 'previous' | 'toggle' | 'next';

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
  /** Last music control asked for. A new `id` means "do it now". */
  music: { id: number; request: MusicRequest } | null;
}

export const INITIAL_DASH_STATE: DashState = {
  page: 'ride',
  focus: 0,
  theme: 'aurora',
  zoom: 15,
  following: true,
  tripResetToken: 0,
  music: null,
};

const MIN_ZOOM = 3;
const MAX_ZOOM = 19;

function goTo(state: DashState, page: DashPage): DashState {
  // The Music page opens on play/pause, its most used control.
  return state.page === page ? state : { ...state, page, focus: page === 'music' ? 1 : 0 };
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

function nextTheme(state: DashState): DashState {
  return { ...state, theme: THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length] };
}

function music(state: DashState, request: MusicRequest): DashState {
  return { ...state, music: { id: (state.music?.id ?? 0) + 1, request } };
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
    case 'musicPrevious':
      return music(state, 'previous');
    case 'musicPlayPause':
      return music(state, 'toggle');
    case 'musicNext':
      return music(state, 'next');
    case 'ride':
    case 'map':
    case 'music':
    case 'trip':
      return goTo(state, item);
    case 'theme':
      return nextTheme(state);
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

export function setTheme(state: DashState, theme: DashTheme): DashState {
  return state.theme === theme ? state : { ...state, theme };
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
      return nextTheme(state);
    case 'resetTrip':
      return { ...state, tripResetToken: state.tripResetToken + 1 };
    case 'musicNext':
      return music(state, 'next');
    case 'musicPrevious':
      return music(state, 'previous');
    case 'musicPlayPause':
      return music(state, 'toggle');
    case 'none':
    default:
      return state;
  }
}
