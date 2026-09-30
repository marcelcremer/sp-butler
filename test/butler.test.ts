import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createButler, trimHistory } from '../src/plugin/butler.ts';
import type { ChatMessage } from '../src/plugin/llm-client.ts';
import { fakeApi, lastToolResult, NOW, say, scriptedLlm, settings, toolCall } from './helpers.ts';

const butlerWith = (llm: ReturnType<typeof scriptedLlm>, api = fakeApi(), extra = {}) =>
  createButler({ api, llm, getSettings: () => Promise.resolve(settings(extra)), now: () => NOW });

describe('butler', () => {
  it('creates a task from natural language after confirmation', async () => {
    const llm = scriptedLlm([
      toolCall('propose_create_tasks', {
        tasks: [{ title: 'Tire change', project: 'Car', estimateMinutes: 30, dueDay: '2026-10-01' }],
      }),
      say('Proposal: tire change tomorrow, 30 min, project Car & Garage.'),
    ]);
    const api = fakeApi();
    const butler = butlerWith(llm, api);

    const res = await butler.chat('s', 'Tire change tomorrow, 30 minutes, project Car');
    assert.deepEqual(res.toolCalls, ['propose_create_tasks']);
    assert.ok(res.proposal);
    assert.equal(res.proposal.items[0]?.project, 'Car & Garage');
    assert.equal(api.calls.length, 0, 'nothing is written before confirmation');

    // The system prompt carries the calendar and the project list.
    const system = llm.requests[0]?.messages[0];
    assert.equal(system?.role, 'system');
    assert.match(system.content, /2026-10-01 Thursday/);
    assert.match(system.content, /Car & Garage \(1 open\)/);

    const results = await butler.apply('s', res.proposal.id, [0]);
    assert.deepEqual(results, [{ ok: true, kind: 'create', title: 'Tire change' }]);
    assert.deepEqual(api.calls[0]?.args[0], {
      title: 'Tire change',
      tagIds: [],
      projectId: 'p-car',
      timeEstimate: 30 * 60000,
      dueDay: '2026-10-01',
    });
    await assert.rejects(butler.apply('s', res.proposal.id, [0]), /no longer exists/);
  });

  it('runs search → update for bulk changes and feeds tool results back', async () => {
    const llm = scriptedLlm([
      toolCall('search_tasks', { dueFrom: '2026-09-30', dueTo: '2026-09-30' }),
      (messages) => {
        const found = lastToolResult(messages) as { tasks: { ref: string }[] };
        return toolCall('propose_update_tasks', {
          changes: found.tasks.map((t) => ({ ref: t.ref, dueDay: '2026-10-02' })),
        });
      },
      say('Moved 3 tasks to Friday – please confirm.'),
    ]);
    const res = await butlerWith(llm).chat('s', 'Move everything from today to Friday');
    assert.deepEqual(res.toolCalls, ['search_tasks', 'propose_update_tasks']);
    assert.ok(res.proposal);
    assert.equal(res.proposal.items.length, 3);
    assert.deepEqual(res.proposal.items[0]?.diff, [['due', '2026-09-30', '2026-10-02']]);
  });

  it('answers questions without a proposal', async () => {
    const llm = scriptedLlm([
      toolCall('search_tasks', { project: 'Household' }),
      say('3 tasks are open in the Household project.'),
    ]);
    const res = await butlerWith(llm).chat('s', 'What is still open in the Household project?');
    assert.equal(res.proposal, undefined);
    assert.equal(res.reply, '3 tasks are open in the Household project.');
  });

  it('keeps refs and history across turns and reports confirmations', async () => {
    const llm = scriptedLlm([
      toolCall('search_tasks', { query: 'milk' }),
      (messages) => {
        const { tasks } = lastToolResult(messages) as { tasks: { ref: string }[] };
        return toolCall('propose_update_tasks', { changes: [{ ref: tasks[0]?.ref, isDone: true }] });
      },
      say('Please confirm.'),
      // Second turn reuses the ref from the first one without searching again.
      (messages) => {
        const firstSearch = messages.find((m) => m.role === 'tool');
        assert.ok(firstSearch);
        const { tasks } = JSON.parse(firstSearch.content) as { tasks: { ref: string }[] };
        return toolCall('get_task', { ref: tasks[0]?.ref });
      },
      say('Marked as done.'),
    ]);
    const butler = butlerWith(llm);
    const first = await butler.chat('s', 'Milk is done');
    assert.ok(first.proposal);
    await butler.apply('s', first.proposal.id, [0]);

    const second = await butler.chat('s', 'Show me that task again');
    assert.equal(second.reply, 'Marked as done.');
    const lastRequest = llm.requests.at(-1);
    assert.ok(lastRequest);
    const system = lastRequest.messages[0];
    assert.match(system?.role === 'system' ? system.content : '', /User confirmed a proposal\. Applied: Buy milk/);
    const tool = lastRequest.messages.at(-1);
    assert.equal(tool?.role, 'tool');
    assert.doesNotMatch(tool.content, /error/);
  });

  it('forces a final answer when the tool budget is exhausted', async () => {
    const llm = scriptedLlm([
      toolCall('search_tasks', {}),
      toolCall('search_tasks', {}),
      say('Summary.'),
    ]);
    const res = await butlerWith(llm, fakeApi(), { maxToolRounds: 2 }).chat('s', 'Overview');
    assert.equal(res.reply, 'Summary.');
    assert.equal(llm.requests[2]?.tools, undefined);
  });

  it('leaves history untouched when the LLM fails', async () => {
    const llm = scriptedLlm([say('Hello!')]);
    const butler = butlerWith(llm);
    await butler.chat('s', 'Hi');
    await assert.rejects(butler.chat('s', 'One more thing'), /no more steps/);
    llm.chat = (req) => {
      assert.deepEqual(
        req.messages.slice(1).map((m) => m.role),
        ['user', 'assistant', 'user'],
      );
      return Promise.resolve(say('ok'));
    };
    await butler.chat('s', 'Again');
  });

  it('discards proposals and resets sessions', async () => {
    const llm = scriptedLlm([toolCall('propose_create_tasks', { tasks: [{ title: 'x' }] }), say('ok'), say('new')]);
    const butler = butlerWith(llm);
    const res = await butler.chat('s', 'x');
    assert.ok(res.proposal);
    butler.discard('s', res.proposal.id);
    await assert.rejects(butler.apply('s', res.proposal.id, [0]));
    butler.reset('s');
    await butler.chat('s', 'hello');
    assert.equal(llm.requests.at(-1)?.messages.length, 2);
  });
});

describe('trimHistory', () => {
  const u = (c: string): ChatMessage => ({ role: 'user', content: c });
  const a = (c: string): ChatMessage => ({ role: 'assistant', content: c });
  const t = (id: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content: '{}' });

  it('cuts only in front of user messages', () => {
    const history = [u('1'), a('1'), u('2'), a('call'), t('x'), a('2'), u('3'), a('3')];
    assert.deepEqual(trimHistory(history, 5), [u('3'), a('3')]);
    assert.deepEqual(trimHistory(history, 6), [u('2'), a('call'), t('x'), a('2'), u('3'), a('3')]);
    assert.equal(trimHistory(history, 100), history);
  });
});
