// Conversation handling: the tool-calling loop plus per-session state
// (history, task refs, open proposals).

import type { ChatResponse, ProposalItemView, ProposalView } from '../shared/protocol.ts';
import { LocalizedError } from '../shared/i18n.ts';
import type { PluginDataApi } from '../types/plugin-api.ts';
import type { ChatMessage, LlmClient } from './llm-client.ts';
import { applyProposal, createProposal, type ApplyResult, type Proposal, type ProposalItem } from './proposal.ts';
import { buildSystemPrompt } from './prompt.ts';
import type { EmbeddingIndex } from './search.ts';
import type { Settings } from './settings.ts';
import { createToolExecutor, TOOL_DEFINITIONS } from './tools.ts';
import { loadWorkspace, RefRegistry } from './workspace.ts';

const MAX_HISTORY_MESSAGES = 40;
const MAX_TOOL_RESULT_CHARS = 24000;

interface Session {
  history: ChatMessage[];
  refs: RefRegistry;
  proposals: Map<string, Proposal>;
  /** Outcomes of confirmations, told to the model on the next turn. */
  events: string[];
}

export interface ButlerDeps {
  api: PluginDataApi;
  llm: LlmClient;
  getSettings: () => Promise<Settings>;
  embeddingIndex?: EmbeddingIndex;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface Butler {
  chat(sessionId: string, text: string): Promise<ChatResponse>;
  apply(sessionId: string, proposalId: string, selected: number[]): Promise<ApplyResult[]>;
  discard(sessionId: string, proposalId: string): void;
  reset(sessionId: string): void;
}

/**
 * Drops the oldest messages, cutting only in front of a user message so that
 * an assistant tool call is never separated from its tool results.
 */
export const trimHistory = (history: ChatMessage[], max = MAX_HISTORY_MESSAGES): ChatMessage[] => {
  if (history.length <= max) return history;
  for (let start = history.length - max; start < history.length; start++) {
    if (history[start]?.role === 'user') return history.slice(start);
  }
  return [];
};

const toView = (proposal: Proposal): ProposalView => ({
  id: proposal.id,
  items: proposal.items.map((item: ProposalItem, index): ProposalItemView => {
    if (item.kind === 'update') {
      return {
        index,
        kind: 'update',
        title: item.display.title,
        project: item.display.project,
        diff: item.display.diff,
        newTags: item.newTags,
      };
    }
    const d = item.display;
    return {
      index,
      kind: 'create',
      title: d.title,
      project: d.project,
      projectIsNew: d.projectIsNew,
      parent: d.parent,
      tags: d.tags,
      estimateMin: d.estimateMin,
      dueDay: d.dueDay,
      notes: d.notes,
      subtasks: item.subtasks.map((s) => ({
        title: s.display.title,
        estimateMin: s.display.estimateMin,
        dueDay: s.display.dueDay,
      })),
    };
  }),
});

export const createButler = ({
  api,
  llm,
  getSettings,
  embeddingIndex,
  now = () => new Date(),
  log,
}: ButlerDeps): Butler => {
  const sessions = new Map<string, Session>();
  let proposalCounter = 0;

  const session = (id: string): Session => {
    let s = sessions.get(id);
    if (!s) {
      s = { history: [], refs: new RefRegistry(), proposals: new Map(), events: [] };
      sessions.set(id, s);
    }
    return s;
  };

  return {
    async chat(sessionId, text) {
      const s = session(sessionId);
      const settings = await getSettings();
      const ws = await loadWorkspace(api);
      const proposal = createProposal(`p${String(++proposalCounter)}`);
      const execute = createToolExecutor({ ws, refs: s.refs, llm, settings, embeddingIndex, proposal, log });

      let system = buildSystemPrompt(ws, settings.customInstructions, now());
      if (s.events.length) system += `\nSince the last message:\n${s.events.map((e) => `- ${e}`).join('\n')}\n`;

      // Work on a copy so a failed turn leaves the history untouched.
      const turn: ChatMessage[] = [...s.history, { role: 'user', content: text }];
      const toolCalls: string[] = [];
      let reply: string | null = null;

      for (let round = 0; round < settings.maxToolRounds; round++) {
        const msg = await llm.chat({ messages: [{ role: 'system', content: system }, ...turn], tools: TOOL_DEFINITIONS });
        turn.push(msg);
        if (!msg.tool_calls?.length) {
          reply = msg.content ?? '';
          break;
        }
        for (const call of msg.tool_calls) {
          toolCalls.push(call.function.name);
          const result = await execute(call.function.name, call.function.arguments);
          let content = JSON.stringify(result);
          if (content.length > MAX_TOOL_RESULT_CHARS) {
            content = `${content.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated – narrow the filters]`;
          }
          turn.push({ role: 'tool', tool_call_id: call.id, content });
        }
      }
      if (reply === null) {
        // Tool budget exhausted: ask for a final answer without tools.
        const msg = await llm.chat({
          messages: [
            { role: 'system', content: system },
            ...turn,
            { role: 'user', content: 'Summarize now without further tool calls.' },
          ],
        });
        turn.push(msg);
        reply = msg.content ?? '';
      }

      s.history = trimHistory(turn);
      s.events = [];
      const response: ChatResponse = { reply, toolCalls };
      if (proposal.items.length) {
        s.proposals.set(proposal.id, proposal);
        response.proposal = toView(proposal);
      }
      return response;
    },

    async apply(sessionId, proposalId, selected) {
      const s = session(sessionId);
      const proposal = s.proposals.get(proposalId);
      if (!proposal) throw new LocalizedError('ERRORS.PROPOSAL_GONE');
      s.proposals.delete(proposalId);
      const results = await applyProposal(api, proposal, selected);
      const ok = results.filter((r) => r.ok).map((r) => r.title);
      const failed = results.filter((r) => !r.ok).map((r) => `${r.title} (${r.error ?? '?'})`);
      const skipped = proposal.items.length - results.length;
      s.events.push(
        `User confirmed a proposal. Applied: ${ok.join(', ') || '–'}` +
          (failed.length ? `; failed: ${failed.join(', ')}` : '') +
          (skipped ? `; ${String(skipped)} item(s) deselected` : ''),
      );
      return results;
    },

    discard(sessionId, proposalId) {
      const s = session(sessionId);
      if (s.proposals.delete(proposalId)) s.events.push('User discarded a proposal.');
    },

    reset(sessionId) {
      sessions.delete(sessionId);
    },
  };
};
