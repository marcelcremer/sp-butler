import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLlmClient } from '../src/plugin/llm-client.ts';
import { settings } from './helpers.ts';

interface Captured {
  url: string;
  init: RequestInit;
}

const fakeFetch = (status: number, body: unknown, captured: Captured[] = []) =>
  (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    });
  };

const client = (fetchImpl: ReturnType<typeof fakeFetch>, apiKey = 'sk-test', extra = {}) =>
  createLlmClient({
    getSettings: () => Promise.resolve(settings({ baseUrl: 'https://llm.example/v1', ...extra })),
    getApiKey: () => Promise.resolve(apiKey),
    fetchImpl,
  });

describe('llm client', () => {
  it('sends chat requests with tools and bearer auth', async () => {
    const captured: Captured[] = [];
    const llm = client(
      fakeFetch(200, { choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: [] } }] }, captured),
    );
    const msg = await llm.chat({
      messages: [{ role: 'user', content: 'hallo' }],
      tools: [{ type: 'function', function: { name: 'x', description: '', parameters: {} } }],
    });
    assert.deepEqual(msg, { role: 'assistant', content: 'hi' });
    const req = captured[0];
    assert.ok(req);
    assert.equal(req.url, 'https://llm.example/v1/chat/completions');
    assert.equal((req.init.headers as Record<string, string>).Authorization, 'Bearer sk-test');
    const body = JSON.parse(req.init.body as string) as Record<string, unknown>;
    assert.equal(body.model, 'test-model');
    assert.equal(body.tool_choice, 'auto');
  });

  it('omits the Authorization header without API key', async () => {
    const captured: Captured[] = [];
    const llm = client(fakeFetch(200, { data: [{ id: 'b' }, { id: 'a' }] }, captured), '');
    assert.deepEqual(await llm.listModels(), ['a', 'b']);
    assert.equal((captured[0]?.init.headers as Record<string, string>).Authorization, undefined);
    assert.equal(captured[0]?.init.method, 'GET');
  });

  it('reports HTTP errors with the server message and a hint', async () => {
    const llm = client(fakeFetch(401, { error: { message: 'invalid key' } }));
    await assert.rejects(llm.listModels(), /HTTP 401.*invalid key.*API-Key/);
  });

  it('explains network errors (e.g. CORS)', async () => {
    const llm = client(() => Promise.reject(new TypeError('Failed to fetch')));
    await assert.rejects(llm.listModels(), /Netzwerkfehler.*CORS/);
  });

  it('requires a chat model', async () => {
    const llm = client(fakeFetch(200, {}), 'k', { chatModel: '' });
    await assert.rejects(llm.chat({ messages: [] }), /Chat-Modell/);
  });

  it('returns embeddings in input order', async () => {
    const llm = client(
      fakeFetch(200, { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }),
      'k',
      { embeddingModel: 'emb' },
    );
    assert.deepEqual(await llm.embed(['a', 'b']), [[1, 0], [0, 1]]);
  });

  it('parses rerank results in Cohere and Jina style', async () => {
    const llm = client(
      fakeFetch(200, { results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }] }),
      'k',
      { rerankModel: 'rr' },
    );
    assert.deepEqual(await llm.rerank('q', ['a', 'b']), [
      { index: 1, score: 0.9 },
      { index: 0, score: 0.1 },
    ]);
  });
});
