// Entry point of plugin.js. Super Productivity evaluates this file inside
// `new Function('plugin', 'PluginAPI', code)`, so `PluginAPI` is in scope.

import { LocalizedError, type Translate } from '../shared/i18n.ts';
import type { SettingsResponse, UiRequest } from '../shared/protocol.ts';
import type { PluginApi } from '../types/plugin-api.ts';
import { createButler } from './butler.ts';
import { createLlmClient } from './llm-client.ts';
import { createEmbeddingIndex } from './search.ts';
import { createSettingsStore, type SettingsStore } from './settings.ts';

declare const PluginAPI: PluginApi;

const isRequest = (m: unknown): m is UiRequest =>
  typeof m === 'object' && m !== null && typeof (m as { type?: unknown }).type === 'string';

const settingsResponse = async (store: SettingsStore): Promise<SettingsResponse> => ({
  settings: await store.load(),
  hasApiKey: Boolean(await store.getApiKey()),
});

export const init = (api: PluginApi): void => {
  // Keys are type-checked against en.json; the host resolves the user's language.
  const t: Translate = (key, params) => api.translate(key, params);
  const store = createSettingsStore(api);
  const llm = createLlmClient({ getSettings: store.load, getApiKey: store.getApiKey });
  const log = (msg: string): void => {
    api.log?.warn(`[sp-butler] ${msg}`);
  };
  const butler = createButler({
    api,
    llm,
    getSettings: store.load,
    embeddingIndex: createEmbeddingIndex(llm),
    log,
  });

  const handle = async (req: UiRequest): Promise<unknown> => {
    switch (req.type) {
      case 'chat':
        return butler.chat(req.sessionId, req.text);
      case 'apply': {
        const results = await butler.apply(req.sessionId, req.proposalId, req.selected);
        const failed = results.filter((r) => !r.ok).length;
        api.showSnack({
          msg: failed
            ? t('SNACK.PARTIALLY_APPLIED', { applied: results.length - failed, failed })
            : t('SNACK.APPLIED', { count: results.length }),
          type: failed ? 'WARNING' : 'SUCCESS',
        });
        return results;
      }
      case 'discard':
        butler.discard(req.sessionId, req.proposalId);
        return null;
      case 'reset':
        butler.reset(req.sessionId);
        return null;
      case 'getSettings':
        return settingsResponse(store);
      case 'saveSettings':
        await store.save(req.settings);
        if (req.apiKey !== undefined) await store.setApiKey(req.apiKey);
        return settingsResponse(store);
      case 'listModels':
        return llm.listModels();
    }
  };

  // Errors are returned as values: the host's message bridge only forwards
  // the message text of thrown errors, and this keeps the contract explicit.
  api.onMessage?.(async (message) => {
    if (!isRequest(message)) return { ok: false, error: t('ERRORS.UNKNOWN_MESSAGE') };
    try {
      return { ok: true, data: await handle(message) };
    } catch (e) {
      if (e instanceof LocalizedError) return { ok: false, error: t(e.key, e.params) };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Settings may change on another device and arrive via sync.
  api.registerHook(api.Hooks.PERSISTED_DATA_CHANGED, () => {
    store.invalidate();
  });

  api.registerShortcut({
    id: 'open-sp-butler',
    label: t('SHORTCUT_OPEN'),
    onExec: () => {
      api.showIndexHtmlAsView();
    },
  });
};

// Not present when this module is imported by tests.
if (typeof PluginAPI !== 'undefined') init(PluginAPI);
