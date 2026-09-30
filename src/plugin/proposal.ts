// A proposal collects the write operations the model suggested in one turn.
// Nothing is changed until the user confirms; then `applyProposal` runs the
// selected items against the Super Productivity API.

import type { PluginDataApi, PluginCreateTaskData, Task } from '../types/plugin-api.ts';
import { normalizeName } from './workspace.ts';

export interface CreateSpec {
  title: string;
  /** Existing project; mutually exclusive with `newProject`. */
  projectId?: string | null;
  /** Project to be created on apply. */
  newProject?: string;
  tagIds: string[];
  /** Tags to be created on apply. */
  newTags: string[];
  notes?: string;
  timeEstimate?: number;
  dueDay?: string | null;
  /** Existing parent task (new subtask of an existing task). */
  parentId?: string;
  subtasks: CreateSpec[];
  display: {
    title: string;
    project?: string;
    parent?: string;
    tags: string[];
    estimateMin?: number;
    dueDay?: string;
    notes?: string;
  };
}

export type DiffRow = [field: string, from: string, to: string];

export interface CreateItem extends CreateSpec {
  kind: 'create';
}

export interface UpdateItem {
  kind: 'update';
  taskId: string;
  updates: Partial<Task>;
  newTags: string[];
  display: { title: string; project?: string; diff: DiffRow[] };
}

export type ProposalItem = CreateItem | UpdateItem;

/** What the model gets back about a proposed item. */
export interface ProposedSummary {
  n: number;
  kind: ProposalItem['kind'];
  title: string;
  changes?: string[];
  subtasks?: number;
}

export interface Proposal {
  id: string;
  items: ProposalItem[];
  add(items: ProposalItem[]): ProposedSummary[];
}

export const createProposal = (id: string): Proposal => {
  const items: ProposalItem[] = [];
  return {
    id,
    items,
    add(newItems) {
      const start = items.length;
      items.push(...newItems);
      return newItems.map((item, i): ProposedSummary => {
        const summary: ProposedSummary = { n: start + i + 1, kind: item.kind, title: item.display.title };
        if (item.kind === 'update') summary.changes = item.display.diff.map(([f, , to]) => `${f}: ${to}`);
        else if (item.subtasks.length) summary.subtasks = item.subtasks.length;
        return summary;
      });
    },
  };
};

export interface ApplyResult {
  ok: boolean;
  kind: ProposalItem['kind'];
  title: string;
  error?: string;
}

type ApplyApi = Pick<PluginDataApi, 'addTask' | 'updateTask' | 'addProject' | 'addTag'>;

/**
 * Applies the selected items (all if `selected` is omitted). New projects and
 * tags are created once per name, before the tasks referencing them. Items
 * are applied independently, so one failure does not abort the rest.
 */
export const applyProposal = async (
  api: ApplyApi,
  proposal: Pick<Proposal, 'items'>,
  selected?: number[],
): Promise<ApplyResult[]> => {
  const chosen = selected ? new Set(selected) : null;
  const items = proposal.items.filter((_, i) => !chosen || chosen.has(i));

  const createdProjects = new Map<string, string>();
  const createdTags = new Map<string, string>();
  const ensure = async (
    cache: Map<string, string>,
    title: string,
    create: (title: string) => Promise<string>,
  ): Promise<string> => {
    const key = normalizeName(title);
    let id = cache.get(key);
    if (!id) {
      id = await create(title);
      cache.set(key, id);
    }
    return id;
  };
  const ensureTags = async (titles: string[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const title of titles) ids.push(await ensure(createdTags, title, (t) => api.addTag({ title: t })));
    return ids;
  };

  const createOne = async (
    spec: CreateSpec,
    parent?: { id: string; projectId: string | null },
  ): Promise<{ id: string; projectId: string | null }> => {
    let projectId: string | null = spec.projectId ?? null;
    if (parent) projectId = parent.projectId;
    else if (spec.newProject) {
      projectId = await ensure(createdProjects, spec.newProject, (t) => api.addProject({ title: t }));
    }
    const data: PluginCreateTaskData = {
      title: spec.title,
      tagIds: [...spec.tagIds, ...(await ensureTags(spec.newTags))],
    };
    if (projectId) data.projectId = projectId;
    const parentId = parent?.id ?? spec.parentId;
    if (parentId) data.parentId = parentId;
    if (spec.notes) data.notes = spec.notes;
    if (spec.timeEstimate) data.timeEstimate = spec.timeEstimate;
    if (spec.dueDay) data.dueDay = spec.dueDay;
    return { id: await api.addTask(data), projectId };
  };

  const results: ApplyResult[] = [];
  for (const item of items) {
    try {
      if (item.kind === 'create') {
        const created = await createOne(item);
        for (const sub of item.subtasks) await createOne(sub, created);
      } else {
        const updates = { ...item.updates };
        if (item.newTags.length) {
          updates.tagIds = [...(updates.tagIds ?? []), ...(await ensureTags(item.newTags))];
        }
        await api.updateTask(item.taskId, updates);
      }
      results.push({ ok: true, kind: item.kind, title: item.display.title });
    } catch (e) {
      results.push({
        ok: false,
        kind: item.kind,
        title: item.display.title,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
};
