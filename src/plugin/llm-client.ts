// Minimal client for OpenAI-compatible endpoints: /chat/completions,
// /embeddings, /rerank (Cohere/Jina style) and /models.
//
// Requests go through plain `fetch` from the host renderer. Super Productivity's
// CSP allows `connect-src *`, so any user-configured base URL works – unlike
// `PluginAPI.request`, which is limited to hosts hard-coded in the manifest.
// On web/desktop the endpoint therefore has to send CORS headers
// (Access-Control-Allow-Origin, -Allow-Headers: Authorization, Content-Type).

import { LocalizedError, type MessageKey, type TranslationParams } from '../shared/i18n.ts';
import type { Settings } from './settings.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface RerankResult {
  index: number;
  score: number;
}

export interface LlmClient {
  chat(req: { messages: ChatMessage[]; tools?: ToolDefinition[] }): Promise<AssistantMessage>;
  embed(inputs: string[]): Promise<number[][]>;
  rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
  listModels(): Promise<string[]>;
}

export class LlmError extends LocalizedError {
  readonly status: number | undefined;

  constructor(key: MessageKey, params: TranslationParams = {}, status?: number) {
    super(key, params);
    this.name = 'LlmError';
    this.status = status;
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

interface ClientDeps {
  getSettings: () => Promise<Settings>;
  getApiKey: () => Promise<string>;
  fetchImpl?: FetchLike;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const errorDetail = (json: unknown, text: string): string => {
  if (isObject(json)) {
    const err = json.error;
    if (isObject(err) && typeof err.message === 'string') return err.message;
    if (typeof err === 'string') return err;
    if (typeof json.detail === 'string') return json.detail;
    if (typeof json.message === 'string') return json.message;
  }
  return text.slice(0, 300);
};

const requireModel = (model: string, missingKey: MessageKey): string => {
  if (!model) throw new LlmError(missingKey);
  return model;
};

export const createLlmClient = ({
  getSettings,
  getApiKey,
  fetchImpl = (url, init) => fetch(url, init),
}: ClientDeps): LlmClient => {
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    const settings = await getSettings();
    const apiKey = await getApiKey();
    const url = `${settings.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, settings.requestTimeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new LlmError('ERRORS.TIMEOUT', { ms: settings.requestTimeoutMs, url });
      }
      throw new LlmError('ERRORS.NETWORK', { url, message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // handled below
    }
    if (!res.ok) {
      const key = res.status === 401 || res.status === 403 ? 'ERRORS.HTTP_AUTH' : 'ERRORS.HTTP';
      throw new LlmError(key, { status: res.status, path, detail: errorDetail(json, text) }, res.status);
    }
    if (json === null) throw new LlmError('ERRORS.INVALID_JSON', { path, snippet: text.slice(0, 200) });
    return json;
  };

  return {
    async chat({ messages, tools }) {
      const settings = await getSettings();
      const body: Record<string, unknown> = {
        model: requireModel(settings.chatModel, 'ERRORS.NO_CHAT_MODEL'),
        messages,
        temperature: settings.temperature,
      };
      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
      const json = await call('/chat/completions', body);
      const choices = isObject(json) && Array.isArray(json.choices) ? (json.choices as unknown[]) : [];
      const first = choices[0];
      const message = isObject(first) ? first.message : undefined;
      if (!isObject(message)) throw new LlmError('ERRORS.NO_CHOICE');
      const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as ToolCall[]) : [];
      return {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
    },

    async embed(inputs) {
      const settings = await getSettings();
      const json = await call('/embeddings', {
        model: requireModel(settings.embeddingModel, 'ERRORS.NO_EMBEDDING_MODEL'),
        input: inputs,
      });
      const data =
        isObject(json) && Array.isArray(json.data)
          ? (json.data as { index?: number; embedding: number[] }[])
          : [];
      if (data.length !== inputs.length) {
        throw new LlmError('ERRORS.EMBEDDING_COUNT', { expected: inputs.length, actual: data.length });
      }
      return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
    },

    async rerank(query, documents, topN) {
      const settings = await getSettings();
      const json = await call('/rerank', {
        model: requireModel(settings.rerankModel, 'ERRORS.NO_RERANK_MODEL'),
        query,
        documents,
        top_n: topN ?? documents.length,
      });
      const raw = isObject(json) ? (json.results ?? json.data) : undefined;
      const results = Array.isArray(raw)
        ? (raw as { index: number; relevance_score?: number; score?: number }[])
        : [];
      return results
        .map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
        .sort((a, b) => b.score - a.score);
    },

    async listModels() {
      const json = await call('/models');
      const data = isObject(json) && Array.isArray(json.data) ? (json.data as { id?: unknown }[]) : [];
      return data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string')
        .sort();
    },
  };
};
