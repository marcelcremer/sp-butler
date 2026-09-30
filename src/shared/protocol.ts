// Messages between the iframe UI (index.html) and the host-side plugin.js.
// The iframe cannot access secret storage and should not hold the API key, so
// all LLM traffic and task changes run in plugin.js.

import type { ApplyResult, DiffRow } from '../plugin/proposal.ts';
import type { Settings } from '../plugin/settings.ts';

export interface ProposalItemView {
  index: number;
  kind: 'create' | 'update';
  title: string;
  project?: string;
  parent?: string;
  tags?: string[];
  estimateMin?: number;
  dueDay?: string;
  notes?: string;
  subtasks?: { title: string; estimateMin?: number; dueDay?: string }[];
  diff?: DiffRow[];
}

export interface ProposalView {
  id: string;
  items: ProposalItemView[];
}

export interface ChatResponse {
  reply: string;
  proposal?: ProposalView;
  /** Names of the tools used this turn, for transparency. */
  toolCalls: string[];
}

export type UiRequest =
  | { type: 'chat'; sessionId: string; text: string }
  | { type: 'apply'; sessionId: string; proposalId: string; selected: number[] }
  | { type: 'discard'; sessionId: string; proposalId: string }
  | { type: 'reset'; sessionId: string }
  | { type: 'getSettings' }
  /** `apiKey` undefined = keep the stored key, '' = delete it. */
  | { type: 'saveSettings'; settings: Partial<Settings>; apiKey?: string }
  | { type: 'listModels' };

export interface SettingsResponse {
  settings: Settings;
  hasApiKey: boolean;
}

export interface UiResponseMap {
  chat: ChatResponse;
  apply: ApplyResult[];
  discard: null;
  reset: null;
  getSettings: SettingsResponse;
  saveSettings: SettingsResponse;
  listModels: string[];
}

export type UiResponse<T extends UiRequest['type']> =
  | { ok: true; data: UiResponseMap[T] }
  | { ok: false; error: string };
