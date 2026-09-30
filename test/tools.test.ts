import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createProposal, type CreateItem, type Proposal, type UpdateItem } from '../src/plugin/proposal.ts';
import { createToolExecutor, dueUpdates, TOOL_DEFINITIONS, type ToolExecutor } from '../src/plugin/tools.ts';
import { createWorkspace, RefRegistry } from '../src/plugin/workspace.ts';
import { fixture, scriptedLlm, settings } from './helpers.ts';

let proposal: Proposal;
let refs: RefRegistry;
let run: (name: string, args: unknown) => Promise<Record<string, unknown>>;

beforeEach(() => {
  proposal = createProposal('p1');
  refs = new RefRegistry();
  const exec: ToolExecutor = createToolExecutor({
    ws: createWorkspace(fixture()),
    refs,
    llm: scriptedLlm([]),
    settings: settings(),
    proposal,
  });
  run = async (name, args) => (await exec(name, JSON.stringify(args))) as Record<string, unknown>;
});

const refOf = async (title: string): Promise<string> => {
  const res = await run('search_tasks', { status: 'all', limit: 150 });
  const found = (res.tasks as { ref: string; title: string }[]).find((t) => t.title === title);
  assert.ok(found, `task ${title} not found`);
  return found.ref;
};

describe('tool definitions', () => {
  it('have unique names and object schemas', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    assert.equal(new Set(names).size, names.length);
    for (const t of TOOL_DEFINITIONS) assert.equal(t.function.parameters.type, 'object');
  });
});

describe('executor', () => {
  it('rejects unknown tools and malformed arguments', async () => {
    const exec = createToolExecutor({
      ws: createWorkspace(fixture()),
      refs,
      llm: scriptedLlm([]),
      settings: settings(),
      proposal,
    });
    assert.deepEqual(await exec('rm_rf', '{}'), { error: 'Unknown tool: rm_rf' });
    assert.deepEqual(await exec('search_tasks', '{nope'), { error: 'Arguments are not valid JSON.' });
    assert.deepEqual(await exec('search_tasks', '[]'), { error: 'Arguments must be a JSON object.' });
    assert.deepEqual(await exec('search_tasks', ''), await exec('search_tasks', '{}'));
  });
});

describe('search_tasks', () => {
  it('lists open tasks sorted by due day with short refs', async () => {
    const res = await run('search_tasks', {});
    const tasks = res.tasks as { ref: string; title: string; dueDay?: string }[];
    assert.equal(res.total, 6);
    assert.deepEqual(
      tasks.map((t) => t.dueDay ?? '-'),
      ['2026-09-30', '2026-09-30', '2026-09-30', '2026-10-03', '2026-10-05', '-'],
    );
    assert.match(tasks[0]?.ref ?? '', /^t\d+$/);
    assert.equal(res.totalEstimateMin, 60);
  });

  it('answers "what is due this week"', async () => {
    const res = await run('search_tasks', { dueFrom: '2026-09-28', dueTo: '2026-10-04' });
    assert.deepEqual(
      (res.tasks as { title: string }[]).map((t) => t.title),
      ['Buy milk', 'Buy bread', 'Car inspection', 'Collect receipts'],
    );
  });

  it('answers "what is open in project X"', async () => {
    const res = await run('search_tasks', { project: 'Household' });
    assert.equal(res.total, 3);
  });

  it('returns known projects on a miss', async () => {
    const res = await run('search_tasks', { project: 'Garden' });
    assert.match(String(res.error), /Garden/);
    assert.deepEqual(res.knownProjects, ['Inbox', 'Car & Garage', 'Household']);
  });

  it('validates dates and status', async () => {
    assert.match(String((await run('search_tasks', { dueFrom: 'Friday' })).error), /YYYY-MM-DD/);
    assert.match(String((await run('search_tasks', { status: 'x' })).error), /status/);
  });

  it('falls back to the full list when no keyword matches', async () => {
    const res = await run('search_tasks', { query: 'groceries', project: 'Household' });
    assert.equal(res.total, 3);
    assert.match(String(res.note), /pick the matching tasks/);
  });

  it('respects the limit', async () => {
    const res = await run('search_tasks', { limit: 2 });
    assert.equal(res.shown, 2);
    assert.equal(res.truncated, true);
  });
});

describe('get_task', () => {
  it('returns subtasks and full notes', async () => {
    const res = await run('get_task', { ref: await refOf('Taxes') });
    assert.equal((res.subtasks as { title: string }[])[0]?.title, 'Collect receipts');
  });

  it('rejects unknown refs', async () => {
    assert.match(String((await run('get_task', { ref: 't999' })).error), /Unknown ref/);
  });
});

describe('propose_create_tasks', () => {
  it('turns "Tire change tomorrow, 30 minutes, project Car" into a proposal', async () => {
    const res = await run('propose_create_tasks', {
      tasks: [{ title: 'Tire change', project: 'Car', estimateMinutes: 30, dueDay: '2026-10-01' }],
    });
    assert.equal(res.status, 'proposed');
    const item = proposal.items[0] as CreateItem;
    assert.equal(item.projectId, 'p-car');
    assert.equal(item.timeEstimate, 30 * 60000);
    assert.equal(item.dueDay, '2026-10-01');
    assert.equal(item.display.project, 'Car & Garage');
  });

  it('marks unknown projects and tags as new and dedupes tags', async () => {
    await run('propose_create_tasks', {
      tasks: [{ title: 'Plant a flower bed', project: 'Garden', tags: ['outdoor', 'Outdoor', '#urgent'] }],
    });
    const item = proposal.items[0] as CreateItem;
    assert.equal(item.newProject, 'Garden');
    assert.deepEqual(item.newTags, ['outdoor']);
    assert.deepEqual(item.tagIds, ['tag-urgent']);
  });

  it('supports brain dumps with subtasks', async () => {
    const res = await run('propose_create_tasks', {
      tasks: [
        { title: 'Plan vacation', subtasks: [{ title: 'Book hotel' }, { title: 'Arrange dog sitter', dueDay: null }] },
        { title: 'Call the dentist', estimateMinutes: 5 },
      ],
    });
    assert.deepEqual(res.items, [
      { n: 1, kind: 'create', title: 'Plan vacation', subtasks: 2 },
      { n: 2, kind: 'create', title: 'Call the dentist' },
    ]);
  });

  it('adds subtasks to existing tasks via parentRef', async () => {
    await run('propose_create_tasks', { tasks: [{ title: 'Bank statements', parentRef: await refOf('Taxes') }] });
    const item = proposal.items[0] as CreateItem;
    assert.equal(item.parentId, 'a5');
    assert.equal(item.projectId, 'INBOX');
  });

  it('rejects nesting deeper than one level', async () => {
    const res = await run('propose_create_tasks', {
      tasks: [{ title: 'x', parentRef: await refOf('Collect receipts') }],
    });
    assert.match(String(res.error), /Subtasks/);
    assert.equal(proposal.items.length, 0);
  });

  it('rejects invalid input', async () => {
    assert.match(String((await run('propose_create_tasks', { tasks: [] })).error), /empty/);
    assert.match(String((await run('propose_create_tasks', { tasks: [{ title: ' ' }] })).error), /title/);
    assert.match(
      String((await run('propose_create_tasks', { tasks: [{ title: 'x', dueDay: 'morgen' }] })).error),
      /YYYY-MM-DD/,
    );
  });
});

describe('propose_update_tasks', () => {
  it('moves everything due today to Friday, keeping times of day', async () => {
    const today = await run('search_tasks', { dueFrom: '2026-09-30', dueTo: '2026-09-30' });
    const changes = (today.tasks as { ref: string }[]).map((t) => ({ ref: t.ref, dueDay: '2026-10-02' }));
    const res = await run('propose_update_tasks', { changes });
    assert.equal((res.items as unknown[]).length, 3);
    const inspection = proposal.items.find((i) => i.display.title === 'Car inspection') as UpdateItem;
    assert.deepEqual(inspection.updates, { dueDay: '2026-10-02', dueWithTime: new Date(2026, 9, 2, 14, 30).getTime() });
    assert.deepEqual(inspection.display.diff, [['due', '2026-09-30', '2026-10-02']]);
  });

  it('marks shopping tasks as done', async () => {
    const shopping = await run('search_tasks', { query: 'buy' });
    const changes = (shopping.tasks as { ref: string }[]).map((t) => ({ ref: t.ref, isDone: true }));
    await run('propose_update_tasks', { changes });
    assert.equal(proposal.items.length, 2);
    const first = proposal.items[0] as UpdateItem;
    assert.equal(first.updates.isDone, true);
    assert.equal(typeof first.updates.doneOn, 'number');
  });

  it('reports per-item errors and still proposes the valid ones', async () => {
    const res = await run('propose_update_tasks', {
      changes: [
        { ref: await refOf('Buy milk'), title: 'Buy oat milk' },
        { ref: 't999', isDone: true },
        { ref: await refOf('Buy bread'), title: 'Buy bread' },
      ],
    });
    assert.equal((res.items as unknown[]).length, 1);
    assert.equal((res.errors as unknown[]).length, 2);
  });

  it('changes tags, project, notes and estimates', async () => {
    const ref = await refOf('Get detergent');
    await run('propose_update_tasks', {
      changes: [
        {
          ref,
          addTags: ['urgent', 'drugstore'],
          removeTags: ['shopping'],
          project: 'Car',
          appendNotes: 'Sensitive skin',
          estimateMinutes: 15,
        },
      ],
    });
    const item = proposal.items[0] as UpdateItem;
    assert.deepEqual(item.updates.tagIds, ['tag-urgent']);
    assert.deepEqual(item.newTags, ['drugstore']);
    assert.equal(item.updates.projectId, 'p-car');
    assert.equal(item.updates.notes, 'Sensitive skin');
    assert.equal(item.updates.timeEstimate, 15 * 60000);
  });

  it('refuses to move subtasks or into unknown projects', async () => {
    const sub = await refOf('Collect receipts');
    const res = await run('propose_update_tasks', {
      changes: [
        { ref: sub, project: 'Household' },
        { ref: await refOf('Buy milk'), project: 'Garden' },
      ],
    });
    assert.equal(res.status, 'nothing proposed');
    assert.equal((res.errors as unknown[]).length, 2);
  });

  it('can clear a due day', async () => {
    await run('propose_update_tasks', { changes: [{ ref: await refOf('Buy milk'), dueDay: null }] });
    assert.deepEqual((proposal.items[0] as UpdateItem).updates, { dueDay: null, dueWithTime: null });
  });
});

describe('dueUpdates', () => {
  it('only sets dueDay for day-only tasks', () => {
    assert.deepEqual(dueUpdates({ dueWithTime: null }, '2026-10-02'), { dueDay: '2026-10-02' });
  });
});
