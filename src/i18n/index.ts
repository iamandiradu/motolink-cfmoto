/**
 * A small dependency-free i18n layer: five bundled languages, dot-path keys
 * checked by TypeScript, `{name}` placeholders, plural forms and iOS/Android
 * variants. The current language lives in a tiny store so components re-render
 * through useT() and non-React code reads it through t().
 */
import { useCallback, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { de } from './de';
import { Strings, en } from './en';
import { es } from './es';
import { it } from './it';
import { ro } from './ro';
import { Leaf, Plural, isPlural, isVariant } from './types';

export { platform, plural } from './types';
export type { Strings } from './en';

export const LANGUAGES = ['en', 'ro', 'de', 'it', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];
/** What the rider picks in Settings: a language, or follow the phone. */
export type LanguageSetting = 'system' | Language;
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['system', ...LANGUAGES];

/** Each language in its own name, so a rider can find theirs whatever is shown now. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  ro: 'Română',
  de: 'Deutsch',
  it: 'Italiano',
  es: 'Español',
};

export const DICTIONARIES: Record<Language, Strings> = { en, ro, de, it, es };

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends Leaf ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every key t() accepts, e.g. 'settings.language'. A typo is a compile error. */
export type TranslationKey = Paths<Strings>;
export type Params = Record<string, string | number>;
export type TFunction = (key: TranslationKey, params?: Params) => string;

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === 'system' || isLanguage(value);
}

// ---------------------------------------------------------------------------
// Device language

/**
 * The phone's locale, read without a native module: Hermes and JSC both
 * report it through Intl. Falls back to English when Intl is missing.
 */
export function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    return 'en';
  }
}

/** 'ro-RO' -> ro, 'de_AT' -> de, 'pt-BR' -> en: one of ours, else English. */
export function languageFromLocale(locale: string | null | undefined): Language {
  const primary = (locale ?? '').split(/[-_]/)[0].toLowerCase();
  return isLanguage(primary) ? primary : 'en';
}

/** The language to use for a setting: the rider's pick, or the phone's when it is one of ours. */
export function resolveLanguage(setting: LanguageSetting, locale: string = deviceLocale()): Language {
  return setting === 'system' ? languageFromLocale(locale) : setting;
}

const SPEECH_REGION: Record<Language, string> = { en: 'en-US', ro: 'ro-RO', de: 'de-DE', it: 'it-IT', es: 'es-ES' };

/**
 * BCP-47 tag for the speech engine. Keeps the phone's own region when it is the
 * same language (de-AT, es-MX), so the voice matches what the rider is used to.
 */
export function speechLanguage(lang: Language, locale: string = deviceLocale()): string {
  const tag = locale.split('-u-')[0].replace(/_/g, '-');
  return languageFromLocale(tag) === lang && /^[a-z]{2}-[A-Za-z]{2}$/.test(tag) ? tag : SPEECH_REGION[lang];
}

// ---------------------------------------------------------------------------
// Plurals

export type PluralCategory = 'one' | 'few' | 'other';

/** Same rules as CLDR for our five languages, for engines without Intl.PluralRules. */
export function fallbackPluralCategory(lang: Language, n: number): PluralCategory {
  if (lang === 'ro') {
    if (n === 1) return 'one';
    const rest = Math.abs(n) % 100;
    return !Number.isInteger(n) || n === 0 || (rest >= 1 && rest <= 19) ? 'few' : 'other';
  }
  return n === 1 ? 'one' : 'other';
}

const pluralRules = new Map<Language, Intl.PluralRules | null>();

function rulesFor(lang: Language): Intl.PluralRules | null {
  if (!pluralRules.has(lang)) {
    let rules: Intl.PluralRules | null = null;
    try {
      // Older Hermes builds ship Intl without PluralRules.
      if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') rules = new Intl.PluralRules(lang);
    } catch {
      rules = null;
    }
    pluralRules.set(lang, rules);
  }
  return pluralRules.get(lang) ?? null;
}

/** one / few / other for a count. CLDR's 'many' (es, it for millions) and the rest map to other. */
export function pluralCategory(lang: Language, n: number): PluralCategory {
  const rules = rulesFor(lang);
  if (!rules) return fallbackPluralCategory(lang, n);
  const category = rules.select(n);
  return category === 'one' || category === 'few' ? category : 'other';
}

function pickPlural(forms: Plural, lang: Language, count: number): string {
  const category = pluralCategory(lang, count);
  if (category === 'one') return forms.one;
  if (category === 'few') return forms.few ?? forms.other;
  return forms.other;
}

// ---------------------------------------------------------------------------
// Lookup

function lookup(dict: Strings, key: string): Leaf | undefined {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' || isPlural(node) || isVariant(node) ? node : undefined;
}

/** Fills `{name}` placeholders; unknown ones are left as they are so a gap is visible. */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** Turns a leaf into the text for one language and platform. */
export function resolveLeaf(leaf: Leaf, lang: Language, params?: Params, os: string = Platform.OS): string {
  let text: string;
  if (typeof leaf === 'string') text = leaf;
  else if (isVariant(leaf)) text = os === 'android' ? leaf.android : leaf.ios;
  else text = pickPlural(leaf, lang, typeof params?.count === 'number' ? params.count : Number(params?.count ?? 0));
  return interpolate(text, params);
}

/** Text for `key` in `lang`. Falls back to English, then to the key itself. */
export function translate(lang: Language, key: TranslationKey, params?: Params): string {
  const leaf = lookup(DICTIONARIES[lang], key) ?? lookup(en, key);
  return leaf === undefined ? key : resolveLeaf(leaf, lang, params);
}

// ---------------------------------------------------------------------------
// Current language

// English until the stored setting is applied at start-up (store.loadPersisted),
// which also keeps tests independent of the machine's locale.
let current: Language = 'en';
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  if (lang === current || !isLanguage(lang)) return;
  current = lang;
  listeners.forEach((listener) => listener());
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Non-React lookups (alerts, checklist, error texts) in the current language. */
export function t(key: TranslationKey, params?: Params): string {
  return translate(current, key, params);
}

/** The current language; re-renders the component when it changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

/** A t() bound to the current language that re-renders the component on a change. */
export function useT(): TFunction {
  const lang = useLanguage();
  return useCallback<TFunction>((key, params) => translate(lang, key, params), [lang]);
}
