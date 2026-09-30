// Task filtering and ranking.
//
// Structured filters (project, tag, due range, status) are applied first. If a
// free-text query is given, candidates are ranked by
//   1. keyword overlap (always available),
//   2. embedding cosine similarity (if an embedding model is configured),
//   3. a rerank of the top candidates (if a rerank model is configured).
// Every semantic step degrades gracefully: if the endpoint fails we keep the
// previous stage's order instead of failing the whole question.

import type { Task } from '../types/plugin-api.ts';
import { taskDueDay } from './dates.ts';
import type { LlmClient } from './llm-client.ts';
import type { Settings } from './settings.ts';
import { normalizeName, type Workspace } from './workspace.ts';

// German and English filler words; users may write in either language.
const STOPWORDS = new Set(
  (
    'der die das den dem des ein eine einen einem einer und oder mit von für fur im in am an auf zu zum zur ' +
    'alle alles noch the and or of for to on at all task tasks aufgabe aufgaben'
  ).split(' '),
);

export const tokenize = (s: string): string[] =>
  normalizeName(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

export const taskSearchText = (task: Task, ws: Workspace): string =>
  [
    task.title,
    ws.projectTitle(task.projectId),
    ...task.tagIds.map((id) => ws.tagTitle(id)),
    task.notes ? task.notes.slice(0, 500) : null,
  ]
    .filter(Boolean)
    .join(' \n');

/** Fraction of query tokens found in the text, 0..1. */
export const keywordScore = (queryTokens: string[], text: string): number => {
  if (!queryTokens.length) return 0;
  const textTokens = tokenize(text);
  // Prefix match in both directions covers simple German inflection and
  // compounds: "Einkauf" ~ "Einkaufen", "Reifen" ~ "Reifenwechsel".
  const matches = (q: string): boolean =>
    textTokens.some((t) => t.startsWith(q) || (q.length >= 4 && t.length >= 4 && q.startsWith(t)));
  return queryTokens.filter(matches).length / queryTokens.length;
};

export const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export interface TaskFilter {
  project?: string;
  tag?: string;
  dueFrom?: string;
  dueTo?: string;
  noDueDay?: boolean;
  status?: 'open' | 'done' | 'all';
  includeSubtasks?: boolean;
}

export const applyFilters = (
  tasks: Task[],
  ws: Workspace,
  f: TaskFilter,
): { tasks: Task[] } | { error: string } => {
  const status = f.status ?? 'open';
  let projectId: string | null = null;
  if (f.project) {
    const p = ws.findProject(f.project);
    if (!p) return { error: `Project "${f.project}" not found.` };
    projectId = p.id;
  }
  let tagId: string | null = null;
  if (f.tag) {
    const t = ws.findTag(f.tag);
    if (!t) return { error: `Tag "${f.tag}" not found.` };
    tagId = t.id;
  }

  return {
    tasks: tasks.filter((task) => {
      if (status === 'open' && task.isDone) return false;
      if (status === 'done' && !task.isDone) return false;
      if (f.includeSubtasks === false && task.parentId) return false;
      if (projectId && task.projectId !== projectId) return false;
      if (tagId && !task.tagIds.includes(tagId)) return false;
      const due = taskDueDay(task);
      if (f.noDueDay && due) return false;
      if (f.dueFrom && (!due || due < f.dueFrom)) return false;
      if (f.dueTo && (!due || due > f.dueTo)) return false;
      return true;
    }),
  };
};

export interface EmbeddingIndex {
  vectorsFor(items: { id: string; text: string }[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

/** Embedding cache keyed by task id; an entry is refreshed when the text changes. */
export const createEmbeddingIndex = (llm: Pick<LlmClient, 'embed'>, batchSize = 64): EmbeddingIndex => {
  const cache = new Map<string, { text: string; vec: number[] }>();
  return {
    async vectorsFor(items) {
      const missing = items.filter(({ id, text }) => cache.get(id)?.text !== text);
      for (let i = 0; i < missing.length; i += batchSize) {
        const chunk = missing.slice(i, i + batchSize);
        const vecs = await llm.embed(chunk.map((m) => m.text));
        chunk.forEach((m, j) => cache.set(m.id, { text: m.text, vec: vecs[j] ?? [] }));
      }
      return items.map(({ id }) => cache.get(id)?.vec ?? []);
    },
    async embedQuery(query) {
      const [vec] = await llm.embed([query]);
      return vec ?? [];
    },
  };
};

export type RankMethod = 'keyword' | 'embedding' | 'rerank';

export interface RankInput {
  tasks: Task[];
  query: string;
  ws: Workspace;
  llm: Pick<LlmClient, 'rerank'>;
  settings: Pick<Settings, 'embeddingModel' | 'rerankModel'>;
  embeddingIndex?: EmbeddingIndex;
  log?: (msg: string) => void;
}

const RERANK_WINDOW = 40;

export const rankTasks = async ({
  tasks,
  query,
  ws,
  llm,
  settings,
  embeddingIndex,
  log,
}: RankInput): Promise<{ ranked: { task: Task; score: number }[]; methods: RankMethod[] }> => {
  const qTokens = tokenize(query);
  let scored = tasks.map((task) => {
    const text = taskSearchText(task, ws);
    return { task, text, score: keywordScore(qTokens, text) };
  });
  const methods: RankMethod[] = ['keyword'];

  if (settings.embeddingModel && embeddingIndex && scored.length) {
    try {
      const qVec = await embeddingIndex.embedQuery(query);
      const vecs = await embeddingIndex.vectorsFor(scored.map((s) => ({ id: s.task.id, text: s.text })));
      scored = scored.map((s, i) => ({ ...s, score: 0.35 * s.score + 0.65 * cosine(qVec, vecs[i] ?? []) }));
      methods.push('embedding');
    } catch (e) {
      log?.(`embedding search failed, keyword only: ${String(e)}`);
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (settings.rerankModel && scored.length > 1) {
    const head = scored.slice(0, RERANK_WINDOW);
    try {
      const ranked = await llm.rerank(
        query,
        head.map((s) => s.text),
        head.length,
      );
      const reranked = ranked.flatMap((r) => {
        const hit = head[r.index];
        return hit ? [{ ...hit, score: r.score }] : [];
      });
      // Keep candidates the reranker did not return, behind the reranked ones.
      const seen = new Set(ranked.map((r) => r.index));
      const dropped = head.filter((_, i) => !seen.has(i));
      scored = [...reranked, ...dropped, ...scored.slice(RERANK_WINDOW)];
      methods.push('rerank');
    } catch (e) {
      log?.(`rerank failed, keeping previous order: ${String(e)}`);
    }
  }

  return { ranked: scored.map(({ task, score }) => ({ task, score })), methods };
};
