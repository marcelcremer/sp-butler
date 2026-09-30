import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyProposal, createProposal, type CreateItem, type UpdateItem } from '../src/plugin/proposal.ts';
import { fakeApi } from './helpers.ts';

const create = (partial: Partial<CreateItem> & { title: string }): CreateItem => ({
  kind: 'create',
  tagIds: [],
  newTags: [],
  subtasks: [],
  display: { title: partial.title, tags: [] },
  ...partial,
});

const update = (taskId: string, updates: UpdateItem['updates'], newTags: string[] = []): UpdateItem => ({
  kind: 'update',
  taskId,
  updates,
  newTags,
  display: { title: taskId, diff: [] },
});

describe('proposal', () => {
  it('numbers items across several add calls', () => {
    const p = createProposal('p');
    p.add([create({ title: 'a' })]);
    assert.deepEqual(p.add([update('x', { isDone: true })]), [
      { n: 2, kind: 'update', title: 'x', changes: [] },
    ]);
  });
});

describe('applyProposal', () => {
  it('creates new projects and tags once, then tasks and subtasks', async () => {
    const api = fakeApi();
    const results = await applyProposal(api, {
      items: [
        create({
          title: 'Urlaub',
          newProject: 'Reisen',
          newTags: ['sommer'],
          timeEstimate: 60000,
          dueDay: '2026-10-01',
          notes: 'n',
          subtasks: [create({ title: 'Hotel', newTags: ['sommer'] })],
        }),
        create({ title: 'Koffer', newProject: 'reisen' }),
      ],
    });
    assert.ok(results.every((r) => r.ok));
    assert.deepEqual(
      api.calls.map((c) => [c.method, c.args[0]]),
      [
        ['addProject', { title: 'Reisen' }],
        ['addTag', { title: 'sommer' }],
        [
          'addTask',
          {
            title: 'Urlaub',
            tagIds: ['new-tag-2'],
            projectId: 'new-project-1',
            notes: 'n',
            timeEstimate: 60000,
            dueDay: '2026-10-01',
          },
        ],
        ['addTask', { title: 'Hotel', tagIds: ['new-tag-2'], projectId: 'new-project-1', parentId: 'new-task-3' }],
        ['addTask', { title: 'Koffer', tagIds: [], projectId: 'new-project-1' }],
      ],
    );
  });

  it('applies only selected items and continues after failures', async () => {
    const api = fakeApi();
    api.updateTask = () => Promise.reject(new Error('boom'));
    const results = await applyProposal(
      api,
      { items: [update('a1', { isDone: true }), create({ title: 'skip me' }), update('a2', {}, ['neu'])] },
      [0, 2],
    );
    assert.deepEqual(
      results.map((r) => [r.ok, r.error]),
      [
        [false, 'boom'],
        [false, 'boom'],
      ],
    );
    assert.ok(!api.calls.some((c) => c.method === 'addTask'));
    assert.ok(api.calls.some((c) => c.method === 'addTag'));
  });
});
