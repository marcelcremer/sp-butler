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
    assert.deepEqual(await exec('rm_rf', '{}'), { error: 'Unbekanntes Tool: rm_rf' });
    assert.deepEqual(await exec('search_tasks', '{nope'), { error: 'Argumente sind kein gültiges JSON.' });
    assert.deepEqual(await exec('search_tasks', '[]'), { error: 'Argumente müssen ein JSON-Objekt sein.' });
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
      ['Milch kaufen', 'Brot kaufen', 'TÜV Termin', 'Belege sammeln'],
    );
  });

  it('answers "what is open in project X"', async () => {
    const res = await run('search_tasks', { project: 'Haushalt' });
    assert.equal(res.total, 3);
  });

  it('returns known projects on a miss', async () => {
    const res = await run('search_tasks', { project: 'Garten' });
    assert.match(String(res.error), /Garten/);
    assert.deepEqual(res.knownProjects, ['Inbox', 'Auto & Werkstatt', 'Haushalt']);
  });

  it('validates dates and status', async () => {
    assert.match(String((await run('search_tasks', { dueFrom: 'Freitag' })).error), /YYYY-MM-DD/);
    assert.match(String((await run('search_tasks', { status: 'x' })).error), /status/);
  });

  it('falls back to the full list when no keyword matches', async () => {
    const res = await run('search_tasks', { query: 'Lebensmittel', project: 'Haushalt' });
    assert.equal(res.total, 3);
    assert.match(String(res.note), /selbst auswählen/);
  });

  it('respects the limit', async () => {
    const res = await run('search_tasks', { limit: 2 });
    assert.equal(res.shown, 2);
    assert.equal(res.truncated, true);
  });
});

describe('get_task', () => {
  it('returns subtasks and full notes', async () => {
    const res = await run('get_task', { ref: await refOf('Steuer') });
    assert.equal((res.subtasks as { title: string }[])[0]?.title, 'Belege sammeln');
  });

  it('rejects unknown refs', async () => {
    assert.match(String((await run('get_task', { ref: 't999' })).error), /Unbekannte ref/);
  });
});

describe('propose_create_tasks', () => {
  it('turns "Morgen Reifenwechsel, 30 Minuten, Projekt Auto" into a proposal', async () => {
    const res = await run('propose_create_tasks', {
      tasks: [{ title: 'Reifenwechsel', project: 'Auto', estimateMinutes: 30, dueDay: '2026-10-01' }],
    });
    assert.equal(res.status, 'proposed');
    const item = proposal.items[0] as CreateItem;
    assert.equal(item.projectId, 'p-auto');
    assert.equal(item.timeEstimate, 30 * 60000);
    assert.equal(item.dueDay, '2026-10-01');
    assert.equal(item.display.project, 'Auto & Werkstatt');
  });

  it('marks unknown projects and tags as new and dedupes tags', async () => {
    await run('propose_create_tasks', {
      tasks: [{ title: 'Beet anlegen', project: 'Garten', tags: ['draußen', 'Draußen', '#dringend'] }],
    });
    const item = proposal.items[0] as CreateItem;
    assert.equal(item.newProject, 'Garten');
    assert.deepEqual(item.newTags, ['draußen']);
    assert.deepEqual(item.tagIds, ['tag-dringend']);
  });

  it('supports brain dumps with subtasks', async () => {
    const res = await run('propose_create_tasks', {
      tasks: [
        { title: 'Urlaub planen', subtasks: [{ title: 'Hotel buchen' }, { title: 'Hund versorgen', dueDay: null }] },
        { title: 'Zahnarzt anrufen', estimateMinutes: 5 },
      ],
    });
    assert.deepEqual(res.items, [
      { n: 1, kind: 'create', title: 'Urlaub planen', subtasks: 2 },
      { n: 2, kind: 'create', title: 'Zahnarzt anrufen' },
    ]);
  });

  it('adds subtasks to existing tasks via parentRef', async () => {
    await run('propose_create_tasks', { tasks: [{ title: 'Kontoauszüge', parentRef: await refOf('Steuer') }] });
    const item = proposal.items[0] as CreateItem;
    assert.equal(item.parentId, 'a5');
    assert.equal(item.projectId, 'INBOX');
  });

  it('rejects nesting deeper than one level', async () => {
    const res = await run('propose_create_tasks', {
      tasks: [{ title: 'x', parentRef: await refOf('Belege sammeln') }],
    });
    assert.match(String(res.error), /Subtasks/);
    assert.equal(proposal.items.length, 0);
  });

  it('rejects invalid input', async () => {
    assert.match(String((await run('propose_create_tasks', { tasks: [] })).error), /leer/);
    assert.match(String((await run('propose_create_tasks', { tasks: [{ title: ' ' }] })).error), /Titel/);
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
    const tuv = proposal.items.find((i) => i.display.title === 'TÜV Termin') as UpdateItem;
    assert.deepEqual(tuv.updates, { dueDay: '2026-10-02', dueWithTime: new Date(2026, 9, 2, 14, 30).getTime() });
    assert.deepEqual(tuv.display.diff, [['Fällig', '2026-09-30', '2026-10-02']]);
  });

  it('marks shopping tasks as done', async () => {
    const shopping = await run('search_tasks', { query: 'kaufen' });
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
        { ref: await refOf('Milch kaufen'), title: 'Hafermilch kaufen' },
        { ref: 't999', isDone: true },
        { ref: await refOf('Brot kaufen'), title: 'Brot kaufen' },
      ],
    });
    assert.equal((res.items as unknown[]).length, 1);
    assert.equal((res.errors as unknown[]).length, 2);
  });

  it('changes tags, project, notes and estimates', async () => {
    const ref = await refOf('Waschmittel besorgen');
    await run('propose_update_tasks', {
      changes: [
        {
          ref,
          addTags: ['dringend', 'drogerie'],
          removeTags: ['einkaufen'],
          project: 'Auto',
          appendNotes: 'Sensitiv',
          estimateMinutes: 15,
        },
      ],
    });
    const item = proposal.items[0] as UpdateItem;
    assert.deepEqual(item.updates.tagIds, ['tag-dringend']);
    assert.deepEqual(item.newTags, ['drogerie']);
    assert.equal(item.updates.projectId, 'p-auto');
    assert.equal(item.updates.notes, 'Sensitiv');
    assert.equal(item.updates.timeEstimate, 15 * 60000);
  });

  it('refuses to move subtasks or into unknown projects', async () => {
    const sub = await refOf('Belege sammeln');
    const res = await run('propose_update_tasks', {
      changes: [
        { ref: sub, project: 'Haushalt' },
        { ref: await refOf('Milch kaufen'), project: 'Garten' },
      ],
    });
    assert.equal(res.status, 'nothing proposed');
    assert.equal((res.errors as unknown[]).length, 2);
  });

  it('can clear a due day', async () => {
    await run('propose_update_tasks', { changes: [{ ref: await refOf('Milch kaufen'), dueDay: null }] });
    assert.deepEqual((proposal.items[0] as UpdateItem).updates, { dueDay: null, dueWithTime: null });
  });
});

describe('dueUpdates', () => {
  it('only sets dueDay for day-only tasks', () => {
    assert.deepEqual(dueUpdates({ dueWithTime: null }, '2026-10-02'), { dueDay: '2026-10-02' });
  });
});
