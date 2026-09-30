// Plugin settings. Non-secret settings are synced via persistDataSynced so they
// follow the user across devices; the API key lives in the local-only secret
// store (never synced, exported or backed up).

import type { PluginApi } from '../types/plugin-api.ts';

export interface Settings {
  baseUrl: string;
  chatModel: string;
  /** Optional. Empty = disabled; keyword search is used instead. */
  embeddingModel: string;
  /** Optional. Empty = disabled. */
  rerankModel: string;
  temperature: number;
  maxToolRounds: number;
  requestTimeoutMs: number;
  /** Appended to the system prompt, e.g. "Einkäufe immer ins Projekt Haushalt". */
  customInstructions: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  baseUrl: 'https://ai-2.1nt.eu/v1',
  chatModel: '',
  embeddingModel: '',
  rerankModel: '',
  temperature: 0.2,
  maxToolRounds: 8,
  requestTimeoutMs: 90000,
  customInstructions: '',
});

const SETTINGS_KEY = 'settings';
const API_KEY_SECRET = 'apiKey';

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  if (value === '' || value === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const normalizeSettings = (raw: unknown): Settings => {
  const r: Partial<Record<keyof Settings, unknown>> = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    baseUrl: (str(r.baseUrl) || d.baseUrl).replace(/\/+$/, ''),
    chatModel: str(r.chatModel),
    embeddingModel: str(r.embeddingModel),
    rerankModel: str(r.rerankModel),
    temperature: clampNumber(r.temperature, 0, 2, d.temperature),
    maxToolRounds: Math.round(clampNumber(r.maxToolRounds, 1, 20, d.maxToolRounds)),
    requestTimeoutMs: Math.round(clampNumber(r.requestTimeoutMs, 5000, 600000, d.requestTimeoutMs)),
    customInstructions: typeof r.customInstructions === 'string' ? r.customInstructions : '',
  };
};

/** Returns an error message or null. */
export const validateBaseUrl = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Base-URL ist keine gültige URL.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Base-URL muss mit http:// oder https:// beginnen.';
  }
  return null;
};

export interface SettingsStore {
  load: () => Promise<Settings>;
  save: (partial: Partial<Settings>) => Promise<Settings>;
  /** Drop the cache, e.g. after a sync delivered new settings. */
  invalidate: () => void;
  getApiKey: () => Promise<string>;
  setApiKey: (key: string) => Promise<void>;
}

type SettingsApi = Pick<
  PluginApi,
  'loadSyncedData' | 'persistDataSynced' | 'getSecret' | 'setSecret' | 'deleteSecret' | 'log'
>;

export const createSettingsStore = (api: SettingsApi): SettingsStore => {
  let cache: Settings | null = null;

  const load = async (): Promise<Settings> => {
    if (cache) return cache;
    let raw: unknown = null;
    try {
      const data = await api.loadSyncedData(SETTINGS_KEY);
      raw = data ? JSON.parse(data) : null;
    } catch (e) {
      api.log?.warn('[sp-butler] could not parse settings, using defaults', e);
    }
    cache = normalizeSettings(raw);
    return cache;
  };

  return {
    load,
    async save(partial) {
      const next = normalizeSettings({ ...(await load()), ...partial });
      const urlError = validateBaseUrl(next.baseUrl);
      if (urlError) throw new Error(urlError);
      await api.persistDataSynced(JSON.stringify(next), SETTINGS_KEY);
      cache = next;
      return next;
    },
    invalidate() {
      cache = null;
    },
    async getApiKey() {
      return (await api.getSecret(API_KEY_SECRET)) ?? '';
    },
    async setApiKey(key) {
      const trimmed = key.trim();
      if (trimmed) await api.setSecret(API_KEY_SECRET, trimmed);
      else await api.deleteSecret(API_KEY_SECRET);
    },
  };
};
