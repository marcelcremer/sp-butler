import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyFilters, cosine, createEmbeddingIndex, keywordScore, rankTasks, tokenize } from '../src/plugin/search.ts';
import { createWorkspace } from '../src/plugin/workspace.ts';
import { fixture, scriptedLlm } from './helpers.ts';

const ws = createWorkspace(fixture());
const ids = (r: { tasks: { id: string }[] } | { error: string }): string[] => {
  assert.ok('tasks' in r, 'error' in r ? r.error : '');
  return r.tasks.map((t) => t.id);
};

describe('filters', () => {
  it('returns open tasks by default', () => {
    assert.ok(!ids(applyFilters(ws.tasks, ws, {})).includes('a7'));
    assert.deepEqual(ids(applyFilters(ws.tasks, ws, { status: 'done' })), ['a7']);
  });

  it('filters by fuzzy project name and tag', () => {
    assert.deepEqual(ids(applyFilters(ws.tasks, ws, { project: 'car' })), ['a4']);
    assert.deepEqual(ids(applyFilters(ws.tasks, ws, { tag: '#Shopping' })), ['a1', 'a2', 'a3']);
  });

  it('filters by due range, including dueWithTime', () => {
    assert.deepEqual(ids(applyFilters(ws.tasks, ws, { dueFrom: '2026-09-30', dueTo: '2026-09-30' })), ['a1', 'a2', 'a4']);
    assert.deepEqual(ids(applyFilters(ws.tasks, ws, { dueFrom: '2026-10-01', dueTo: '2026-10-04' })), ['a6']);
    assert.deepEqual(ids(applyFilters(ws.tasks, ws, { noDueDay: true })), ['a3']);
  });

  it('can exclude subtasks', () => {
    assert.ok(!ids(applyFilters(ws.tasks, ws, { includeSubtasks: false })).includes('a6'));
  });

  it('reports unknown projects', () => {
    assert.deepEqual(applyFilters(ws.tasks, ws, { project: 'Garden' }), { error: 'Project "Garden" not found.' });
  });
});

describe('keyword ranking', () => {
  it('drops English and German filler words and accents', () => {
    assert.deepEqual(tokenize('All tasks for the TÜV!'), ['tuv']);
    assert.deepEqual(tokenize('Alle Aufgaben für den TÜV!'), ['tuv']);
  });

  it('matches word prefixes in both directions', () => {
    assert.equal(keywordScore(tokenize('shop'), 'Buy bread shopping'), 1);
    assert.equal(keywordScore(tokenize('receipts'), 'Collect receipt'), 1);
    assert.equal(keywordScore(tokenize('Garden'), 'Buy bread'), 0);
  });

  it('ranks keyword hits first without semantic models', async () => {
    const { ranked, methods } = await rankTasks({
      tasks: ws.tasks,
      query: 'shopping',
      ws,
      llm: scriptedLlm([]),
      settings: { embeddingModel: '', rerankModel: '' },
    });
    assert.deepEqual(methods, ['keyword']);
    assert.deepEqual(
      ranked.filter((r) => r.score > 0).map((r) => r.task.id),
      ['a1', 'a2', 'a3'],
    );
  });
});

describe('semantic ranking', () => {
  it('computes cosine similarity', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });

  it('uses embeddings and caches task vectors', async () => {
    let embedCalls = 0;
    const vec = (text: string): number[] => (/detergent|Cleaning/.test(text) ? [1, 0] : [0, 1]);
    const index = createEmbeddingIndex({
      embed: (inputs) => {
        embedCalls++;
        return Promise.resolve(inputs.map(vec));
      },
    });
    const run = () =>
      rankTasks({
        tasks: ws.tasks,
        query: 'Cleaning',
        ws,
        llm: scriptedLlm([]),
        settings: { embeddingModel: 'emb', rerankModel: '' },
        embeddingIndex: index,
      });
    const first = await run();
    assert.deepEqual(first.methods, ['keyword', 'embedding']);
    assert.equal(first.ranked[0]?.task.id, 'a3');
    await run();
    assert.equal(embedCalls, 3, 'second run only embeds the query');
  });

  it('applies rerank and keeps candidates the reranker dropped', async () => {
    const llm = scriptedLlm([]);
    llm.rerank = () => Promise.resolve([{ index: 2, score: 0.9 }]);
    const tasks = ws.tasks.slice(0, 3);
    const { ranked, methods } = await rankTasks({
      tasks,
      query: 'x',
      ws,
      llm,
      settings: { embeddingModel: '', rerankModel: 'rr' },
    });
    assert.deepEqual(methods, ['keyword', 'rerank']);
    assert.deepEqual(
      ranked.map((r) => r.task.id),
      ['a3', 'a1', 'a2'],
    );
  });

  it('falls back to keyword order when the endpoint fails', async () => {
    const logs: string[] = [];
    const { methods } = await rankTasks({
      tasks: ws.tasks,
      query: 'milk',
      ws,
      llm: scriptedLlm([]),
      settings: { embeddingModel: 'emb', rerankModel: 'rr' },
      embeddingIndex: createEmbeddingIndex({ embed: () => Promise.reject(new Error('down')) }),
      log: (m) => logs.push(m),
    });
    assert.deepEqual(methods, ['keyword']);
    assert.equal(logs.length, 2);
  });
});
