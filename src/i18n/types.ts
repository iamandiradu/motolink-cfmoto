/**
 * Shapes shared by the language files. Kept apart from index.ts so en.ts can
 * use the helpers without importing the store (which imports en.ts).
 */

/**
 * A text with plural forms, picked by the `count` parameter. `few` is only
 * used by languages that have it (Romanian: 2-19, 0 and decimals); the others
 * leave it out and fall back to `other`.
 */
export interface Plural {
  one: string;
  few?: string;
  other: string;
}

/** A text that differs between iOS and Android, picked by Platform.OS. */
export interface Variant {
  ios: string;
  android: string;
}

export type Leaf = string | Plural | Variant;

/** Marks a plural entry, so its type is Plural (with optional `few`) in every language. */
export const plural = (forms: Plural): Plural => forms;

/** Marks a platform entry, so every language must give both texts. */
export const platform = (texts: Variant): Variant => texts;

export function isPlural(leaf: unknown): leaf is Plural {
  return typeof leaf === 'object' && leaf !== null && 'one' in leaf && 'other' in leaf;
}

export function isVariant(leaf: unknown): leaf is Variant {
  return typeof leaf === 'object' && leaf !== null && 'ios' in leaf && 'android' in leaf;
}
