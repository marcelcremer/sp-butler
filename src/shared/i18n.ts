// Translation helpers shared by plugin.js and the iframe UI.
//
// src/i18n/*.json is the single source of truth. The build ships the files as
// i18n/ in the plugin ZIP, where Super Productivity loads them for
// PluginAPI.translate() (used by plugin.js). The iframe only has an async
// translate() over the message bridge, so the UI bundles the same files and
// translates synchronously with `createTranslator`.

import en from '../i18n/en.json' with { type: 'json' };

export type Messages = typeof en;
export type TranslationParams = Record<string, string | number>;

/** Dot-separated paths to every string leaf of en.json, e.g. "ERRORS.NETWORK". */
type LeafPaths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafPaths<T[K]>}`;
}[keyof T & string];

export type MessageKey = LeafPaths<Messages>;

export type Translate = (key: MessageKey, params?: TranslationParams) => string;

/** Same placeholder syntax as Super Productivity: {{name}}. */
export const interpolate = (template: string, params: TranslationParams = {}): string =>
  template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );

export const lookup = (dict: unknown, key: string): string | undefined => {
  let node = dict;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
};

/** Translator with English fallback, then the key itself (like the host). */
export const createTranslator = (dict: unknown): Translate => (key, params) =>
  interpolate(lookup(dict, key) ?? lookup(en, key) ?? key, params);

export const translateEn: Translate = createTranslator(en);

/**
 * An error whose message is meant for the user. It carries a translation key
 * so the host can show it in the user's language; `message` is the English
 * text for logs and tests.
 */
export class LocalizedError extends Error {
  readonly key: MessageKey;
  readonly params: TranslationParams;

  constructor(key: MessageKey, params: TranslationParams = {}) {
    super(translateEn(key, params));
    this.name = 'LocalizedError';
    this.key = key;
    this.params = params;
  }
}
