// UI translations. The iframe's PluginAPI.translate() is async (message
// bridge), which does not fit rendering, so the UI bundles the same
// i18n/*.json files the host uses and only asks the host for the language.

import de from '../i18n/de.json' with { type: 'json' };
import en from '../i18n/en.json' with { type: 'json' };
import { createTranslator, translateEn, type MessageKey, type Translate } from '../shared/i18n.ts';
import type { PluginIframeApi } from '../types/plugin-api.ts';

const DICTIONARIES: Record<string, unknown> = { en, de };
const LANGUAGE_TIMEOUT_MS = 1500;

let current: Translate = translateEn;

export const t: Translate = (key, params) => current(key, params);

/** "de", "de-DE", "DE" → "de"; unknown languages → "en". */
export const resolveLanguage = (code: string | null | undefined): string => {
  const normalized = (code ?? '').toLowerCase().replace('_', '-');
  if (normalized in DICTIONARIES) return normalized;
  const base = normalized.split('-')[0] ?? '';
  return base in DICTIONARIES ? base : 'en';
};

export const initLanguage = async (api: PluginIframeApi | undefined): Promise<string> => {
  let code: string | null = null;
  try {
    code = api
      ? await Promise.race([
          api.getCurrentLanguage(),
          new Promise<null>((resolve) => setTimeout(() => {
            resolve(null);
          }, LANGUAGE_TIMEOUT_MS)),
        ])
      : null;
  } catch {
    // keep English
  }
  const lang = resolveLanguage(code);
  current = createTranslator(DICTIONARIES[lang]);
  document.documentElement.lang = lang;
  return lang;
};

const ATTRIBUTES = {
  'data-i18n-placeholder': 'placeholder',
  'data-i18n-title': 'title',
  'data-i18n-aria-label': 'aria-label',
} as const;

/**
 * Fills static markup: data-i18n sets the text, data-i18n-placeholder /
 * -title / -aria-label set those attributes. Keys are not type-checked in
 * HTML; a test verifies that every key used in index.html exists.
 */
export const translateStatic = (root: ParentNode): void => {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as MessageKey);
  });
  for (const [dataAttr, attr] of Object.entries(ATTRIBUTES)) {
    root.querySelectorAll<HTMLElement>(`[${dataAttr}]`).forEach((el) => {
      el.setAttribute(attr, t(el.getAttribute(dataAttr) as MessageKey));
    });
  }
};
