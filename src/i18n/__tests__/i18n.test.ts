import { evaluateAlerts, DEFAULT_COMFORT_SETTINGS, type AlertInput } from '../../comfort/alerts';
import { EMPTY_METRICS } from '../../metrics/trip';
import {
  DICTIONARIES,
  LANGUAGES,
  Language,
  fallbackPluralCategory,
  getLanguage,
  languageFromLocale,
  pluralCategory,
  resolveLanguage,
  resolveLeaf,
  setLanguage,
  speechLanguage,
  subscribeLanguage,
  t,
  translate,
} from '../index';
import { isPlural, isVariant } from '../types';

type Entry = { key: string; leaf: unknown };

/** Every leaf of a dictionary with its dot path; plural and platform entries count as one leaf. */
function leaves(node: unknown, prefix = ''): Entry[] {
  if (typeof node === 'string' || isPlural(node) || isVariant(node)) return [{ key: prefix, leaf: node }];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

/** Every text inside a leaf: each plural form, each platform variant. */
function texts(leaf: unknown): string[] {
  if (typeof leaf === 'string') return [leaf];
  return Object.values(leaf as Record<string, string>);
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const english = leaves(DICTIONARIES.en);
const OTHERS = LANGUAGES.filter((lang) => lang !== 'en');

afterEach(() => setLanguage('en'));

describe('dictionaries', () => {
  it('has a sizeable English source', () => {
    expect(english.length).toBeGreaterThan(400);
  });

  it.each(OTHERS)('%s has exactly the English keys', (lang) => {
    const keys = leaves(DICTIONARIES[lang]).map((e) => e.key);
    expect(keys.sort()).toEqual(english.map((e) => e.key).sort());
  });

  it.each(LANGUAGES)('%s has no empty texts', (lang) => {
    for (const { key, leaf } of leaves(DICTIONARIES[lang])) {
      for (const text of texts(leaf)) expect({ key, empty: text.trim().length === 0 }).toEqual({ key, empty: false });
    }
  });

  it.each(OTHERS)('%s keeps the English kind of entry (text, plural or platform)', (lang) => {
    const theirs = new Map(leaves(DICTIONARIES[lang]).map((e) => [e.key, e.leaf]));
    for (const { key, leaf } of english) {
      const other = theirs.get(key);
      expect({ key, plural: isPlural(other), variant: isVariant(other) }).toEqual({
        key,
        plural: isPlural(leaf),
        variant: isVariant(leaf),
      });
    }
  });

  it.each(OTHERS)('%s uses exactly the English placeholders', (lang) => {
    const theirs = new Map(leaves(DICTIONARIES[lang]).map((e) => [e.key, e.leaf]));
    for (const { key, leaf } of english) {
      const expected = placeholders(texts(leaf)[0]);
      for (const text of texts(theirs.get(key))) {
        expect({ key, placeholders: placeholders(text) }).toEqual({ key, placeholders: expected });
      }
    }
  });

  it('gives Romanian plurals all three forms', () => {
    for (const { key, leaf } of leaves(DICTIONARIES.ro)) {
      if (isPlural(leaf)) expect({ key, few: typeof leaf.few }).toEqual({ key, few: 'string' });
    }
  });

  it.each(LANGUAGES)('%s keeps dash tab titles to one short word', (lang) => {
    for (const title of Object.values(DICTIONARIES[lang].dash.pages)) {
      expect(title).toMatch(/^\S+$/);
      expect(title.length).toBeLessThanOrEqual(8);
    }
  });
});

describe('dash strip alerts', () => {
  const base: AlertInput = {
    metrics: EMPTY_METRICS,
    batteryLevel: null,
    charging: false,
    linkConnected: true,
    linkExpected: true,
    mirroring: true,
    mirroringExpected: true,
    settings: DEFAULT_COMFORT_SETTINGS,
    now: 0,
  };

  /** Every alert at its widest: three-digit numbers and the longer unit. */
  function widest(imperial: boolean) {
    return [
      ...evaluateAlerts({
        ...base,
        imperial,
        metrics: { ...EMPTY_METRICS, speedKmh: 400, accuracyM: null },
        riding: true,
        linkConnected: false,
        settings: { ...DEFAULT_COMFORT_SETTINGS, speedWarningKmh: 200, fuelRangeKm: 999, kmSinceRefuel: 800, lowBatteryPercent: 99 },
        // Full battery still alerting: the hysteresis margin lifts the threshold past 100 %.
        batteryLevel: 1,
        previous: ['battery'],
        thermal: 'critical',
      }),
      ...evaluateAlerts({ ...base, imperial, settings: { ...DEFAULT_COMFORT_SETTINGS, fuelRangeKm: 600, kmSinceRefuel: 600 } }),
      ...evaluateAlerts({ ...base, imperial, riding: true, mirroring: false, metrics: { ...EMPTY_METRICS, accuracyM: 5 } }),
    ];
  }

  it.each(LANGUAGES)('%s keeps every short text within 18 characters', (lang: Language) => {
    setLanguage(lang);
    for (const imperial of [false, true]) {
      const alerts = widest(imperial);
      expect(new Set(alerts.map((a) => a.id))).toEqual(
        new Set(['speed', 'fuel', 'battery', 'thermal', 'gps', 'link', 'mirroring']),
      );
      for (const alert of alerts) {
        expect({ id: alert.id, short: alert.short, fits: alert.short.length <= 18 }).toEqual({
          id: alert.id,
          short: alert.short,
          fits: true,
        });
        expect(alert.spoken).toMatch(/[.!]$/);
      }
    }
  });

  it('builds alerts in the current language', () => {
    setLanguage('de');
    const [alert] = evaluateAlerts({ ...base, settings: { ...DEFAULT_COMFORT_SETTINGS, fuelRangeKm: 100, kmSinceRefuel: 100 } });
    expect(alert.short).toBe(DICTIONARIES.de.alerts.fuelEmptyShort);
  });
});

describe('plurals', () => {
  it('picks the three Romanian forms for 1, 2 and 20', () => {
    expect(pluralCategory('ro', 1)).toBe('one');
    expect(pluralCategory('ro', 2)).toBe('few');
    expect(pluralCategory('ro', 20)).toBe('other');
    expect(pluralCategory('ro', 0)).toBe('few');
    expect(pluralCategory('ro', 119)).toBe('few');
  });

  it('has a fallback that agrees with Intl.PluralRules', () => {
    for (const lang of LANGUAGES) {
      for (const n of [0, 1, 2, 5, 19, 20, 21, 101, 119, 120, 1000]) {
        expect({ lang, n, c: fallbackPluralCategory(lang, n) }).toEqual({ lang, n, c: pluralCategory(lang, n) });
      }
    }
  });

  it('works when Intl.PluralRules is missing (older Hermes)', () => {
    jest.isolateModules(() => {
      const saved = Object.getOwnPropertyDescriptor(Intl, 'PluralRules')!;
      // Simulates an engine without PluralRules.
      Object.defineProperty(Intl, 'PluralRules', { value: undefined, configurable: true, writable: true });
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const i18n = require('../index') as typeof import('../index');
        expect(i18n.pluralCategory('ro', 20)).toBe('other');
        expect(i18n.translate('ro', 'stats.monthA11y', { month: 'ian.', year: 2026, distance: '1 km', count: 2 })).toBe(
          'ian. 2026: 1 km, 2 ture',
        );
      } finally {
        Object.defineProperty(Intl, 'PluralRules', saved);
      }
    });
  });

  it('fills the chosen form', () => {
    const params = (count: number) => ({ month: 'Nov', year: 2026, distance: '5.0 km', count });
    expect(translate('en', 'stats.monthA11y', params(1))).toBe('Nov 2026: 5.0 km, 1 ride');
    expect(translate('en', 'stats.monthA11y', params(3))).toBe('Nov 2026: 5.0 km, 3 rides');
    expect(translate('ro', 'stats.monthA11y', params(1))).toMatch(/1 tură$/);
    expect(translate('ro', 'stats.monthA11y', params(2))).toMatch(/2 ture$/);
    expect(translate('ro', 'stats.monthA11y', params(20))).toMatch(/20 de ture$/);
  });
});

describe('device language', () => {
  it('maps a locale to one of ours, else English', () => {
    expect(languageFromLocale('ro-RO')).toBe('ro');
    expect(languageFromLocale('de-AT')).toBe('de');
    expect(languageFromLocale('it_IT')).toBe('it');
    expect(languageFromLocale('es-419')).toBe('es');
    expect(languageFromLocale('en-GB')).toBe('en');
    expect(languageFromLocale('pt-BR')).toBe('en');
    expect(languageFromLocale('')).toBe('en');
    expect(languageFromLocale(undefined)).toBe('en');
  });

  it('follows the phone only for the system setting', () => {
    expect(resolveLanguage('system', 'es-MX')).toBe('es');
    expect(resolveLanguage('system', 'fr-FR')).toBe('en');
    expect(resolveLanguage('de', 'es-MX')).toBe('de');
  });

  it('gives the speech engine a full tag, keeping the phone region of the same language', () => {
    expect(speechLanguage('de', 'de-AT')).toBe('de-AT');
    expect(speechLanguage('de', 'ro-RO')).toBe('de-DE');
    expect(speechLanguage('ro', 'en-US')).toBe('ro-RO');
    expect(speechLanguage('es', 'es-MX-u-ca-gregory')).toBe('es-MX');
  });
});

describe('lookup', () => {
  it('resolves platform variants by OS', () => {
    const leaf = DICTIONARIES.en.wifi.stepJoin;
    expect(resolveLeaf(leaf, 'en', undefined, 'ios')).toBe('Tap Join if iOS asks.');
    expect(resolveLeaf(leaf, 'en', undefined, 'android')).toBe('Tap Connect if the phone asks.');
    // Tests run as iOS under jest-expo.
    expect(t('wifi.stepJoin')).toBe('Tap Join if iOS asks.');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate('en', 'kit.dismiss', { title: 'Tips' })).toBe('Dismiss: Tips');
    expect(translate('en', 'kit.dismiss')).toBe('Dismiss: {title}');
  });

  it('switches language through the store and notifies', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeLanguage(listener);
    expect(getLanguage()).toBe('en');
    setLanguage('it');
    setLanguage('it');
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLanguage()).toBe('it');
    expect(t('tabs.settings')).toBe(DICTIONARIES.it.tabs.settings);
  });
});
