import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSettingsStore, DEFAULT_SETTINGS, normalizeSettings, validateBaseUrl } from '../src/plugin/settings.ts';

const memoryApi = () => {
  const synced = new Map<string, string>();
  const secrets = new Map<string, string>();
  return {
    synced,
    secrets,
    loadSyncedData: (key?: string) => Promise.resolve(synced.get(key ?? '') ?? null),
    persistDataSynced: (data: string, key?: string) => {
      synced.set(key ?? '', data);
      return Promise.resolve();
    },
    getSecret: (key: string) => Promise.resolve(secrets.get(key) ?? null),
    setSecret: (key: string, value: string) => {
      secrets.set(key, value);
      return Promise.resolve();
    },
    deleteSecret: (key: string) => {
      secrets.delete(key);
      return Promise.resolve();
    },
  };
};

describe('settings', () => {
  it('normalizes and clamps values', () => {
    const s = normalizeSettings({ baseUrl: ' https://x.example/v1/// ', temperature: 7, maxToolRounds: 'abc' });
    assert.equal(s.baseUrl, 'https://x.example/v1');
    assert.equal(s.temperature, 2);
    assert.equal(s.maxToolRounds, DEFAULT_SETTINGS.maxToolRounds);
    assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  });

  it('validates the base URL', () => {
    assert.equal(validateBaseUrl('https://ai-2.1nt.eu/v1'), null);
    assert.ok(validateBaseUrl('ftp://x'));
    assert.ok(validateBaseUrl('not a url'));
  });

  it('persists settings synced and the API key as local secret only', async () => {
    const api = memoryApi();
    const store = createSettingsStore(api);
    await store.save({ chatModel: 'qwen', baseUrl: 'http://localhost:8080/v1' });
    await store.setApiKey('  sk-123 ');

    const persisted = api.synced.get('settings') ?? '';
    assert.match(persisted, /"chatModel":"qwen"/);
    assert.doesNotMatch(persisted, /sk-123/);
    assert.equal(await store.getApiKey(), 'sk-123');

    await store.setApiKey('');
    assert.equal(await store.getApiKey(), '');
  });

  it('rejects invalid URLs on save and keeps the old value', async () => {
    const store = createSettingsStore(memoryApi());
    await assert.rejects(store.save({ baseUrl: 'javascript:alert(1)' }), /http/);
    assert.equal((await store.load()).baseUrl, DEFAULT_SETTINGS.baseUrl);
  });

  it('reloads after invalidate (sync from another device)', async () => {
    const api = memoryApi();
    const store = createSettingsStore(api);
    assert.equal((await store.load()).chatModel, '');
    api.synced.set('settings', JSON.stringify({ chatModel: 'remote' }));
    assert.equal((await store.load()).chatModel, '');
    store.invalidate();
    assert.equal((await store.load()).chatModel, 'remote');
  });
});
