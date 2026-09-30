import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import de from '../src/i18n/de.json' with { type: 'json' };
import { init } from '../src/plugin/main.ts';
import { createTranslator, translateEn, type Translate } from '../src/shared/i18n.ts';
import type { PluginApi } from '../src/types/plugin-api.ts';
import { fakeApi } from './helpers.ts';

const setup = (translate: Translate = translateEn) => {
  let handler: ((m: unknown) => Promise<unknown>) | undefined;
  const hooks: string[] = [];
  const shortcuts: string[] = [];
  const secrets = new Map<string, string>();
  const synced = new Map<string, string>();
  const api: PluginApi = {
    ...fakeApi(),
    Hooks: { PERSISTED_DATA_CHANGED: 'persistedDataChanged' },
    // Stands in for the host's i18n lookup of i18n/<lang>.json.
    translate: (key, params) => translate(key as Parameters<Translate>[0], params),
    registerHook: (hook) => hooks.push(hook),
    registerShortcut: (cfg) => shortcuts.push(cfg.id ?? cfg.label),
    showIndexHtmlAsView: () => undefined,
    showSnack: () => undefined,
    onMessage: (h) => {
      handler = h;
    },
    persistDataSynced: (d, k) => {
      synced.set(k ?? '', d);
      return Promise.resolve();
    },
    loadSyncedData: (k) => Promise.resolve(synced.get(k ?? '') ?? null),
    setSecret: (k, v) => {
      secrets.set(k, v);
      return Promise.resolve();
    },
    getSecret: (k) => Promise.resolve(secrets.get(k) ?? null),
    deleteSecret: (k) => {
      secrets.delete(k);
      return Promise.resolve();
    },
  };
  init(api);
  assert.ok(handler);
  return { send: handler, hooks, shortcuts, secrets, synced };
};

describe('plugin entry', () => {
  it('registers the sync hook and shortcut', () => {
    const { hooks, shortcuts } = setup();
    assert.deepEqual(hooks, ['persistedDataChanged']);
    assert.deepEqual(shortcuts, ['open-sp-butler']);
  });

  it('saves settings without leaking the key into synced data', async () => {
    const { send, secrets, synced } = setup();
    const res = (await send({
      type: 'saveSettings',
      settings: { chatModel: 'm' },
      apiKey: 'sk-1',
    })) as { ok: boolean; data: { hasApiKey: boolean; settings: { chatModel: string } } };
    assert.equal(res.ok, true);
    assert.equal(res.data.hasApiKey, true);
    assert.equal(res.data.settings.chatModel, 'm');
    assert.equal(secrets.get('apiKey'), 'sk-1');
    assert.doesNotMatch(synced.get('settings') ?? '', /sk-1/);

    // apiKey undefined keeps the stored key
    await send({ type: 'saveSettings', settings: {} });
    assert.equal(secrets.get('apiKey'), 'sk-1');
  });

  it('returns errors as values', async () => {
    const { send } = setup();
    assert.deepEqual(await send('nope'), { ok: false, error: 'Unknown message.' });
    const res = (await send({ type: 'chat', sessionId: 's', text: 'hi' })) as { ok: boolean; error: string };
    assert.equal(res.ok, false);
    assert.match(res.error, /chat model/);
    const apply = (await send({ type: 'apply', sessionId: 's', proposalId: 'p', selected: [] })) as { ok: boolean };
    assert.equal(apply.ok, false);
  });

  it('translates user-facing errors via the host', async () => {
    const { send } = setup(createTranslator(de));
    const res = (await send({ type: 'chat', sessionId: 's', text: 'hi' })) as { ok: boolean; error: string };
    assert.equal(res.error, 'Kein Chat-Modell konfiguriert (Einstellungen).');
    const bad = (await send({ type: 'saveSettings', settings: { baseUrl: 'ftp://x' } })) as { error: string };
    assert.equal(bad.error, 'Base-URL muss mit http:// oder https:// beginnen.');
  });
});
