// A snapshot of the user's data plus the helpers the tools need: short task
// references, project/tag name resolution and compact task serialization.

import type { PluginDataApi, Project, Tag, Task } from '../types/plugin-api.ts';
import { taskDueDay } from './dates.ts';

export const TODAY_TAG_ID = 'TODAY';

export const normalizeName = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^#/, '')
    .trim();

export const truncate = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * Maps Super Productivity's long task ids to short refs ("t1", "t2", …). The
 * model only ever sees refs, which saves tokens and makes copy mistakes
 * detectable. A registry lives as long as a conversation, so refs stay stable
 * across turns.
 */
export class RefRegistry {
  private readonly idToRef = new Map<string, string>();
  private readonly refToId = new Map<string, string>();
  private counter = 0;

  refFor(id: string): string {
    let ref = this.idToRef.get(id);
    if (!ref) {
      ref = `t${String(++this.counter)}`;
      this.idToRef.set(id, ref);
      this.refToId.set(ref, id);
    }
    return ref;
  }

  idFor(ref: string): string | null {
    return this.refToId.get(ref.trim()) ?? null;
  }
}

export interface Workspace {
  tasks: Task[];
  projects: Project[];
  tags: Tag[];
  taskById: Map<string, Task>;
  findProject(nameOrId: string): Project | null;
  findTag(nameOrId: string): Tag | null;
  projectTitle(id: string | null | undefined): string | null;
  tagTitle(id: string): string | null;
}

const uniqueOrNull = <T>(list: T[]): T | null => (list.length === 1 ? (list[0] ?? null) : null);

const findByName = <T extends { id: string; title: string }>(list: T[], nameOrId: string): T | null => {
  if (!nameOrId.trim()) return null;
  const byId = list.find((x) => x.id === nameOrId);
  if (byId) return byId;
  const n = normalizeName(nameOrId);
  return (
    list.find((x) => normalizeName(x.title) === n) ??
    // Unique prefix/substring match ("Auto" -> "Auto & Werkstatt")
    uniqueOrNull(list.filter((x) => normalizeName(x.title).startsWith(n))) ??
    uniqueOrNull(list.filter((x) => normalizeName(x.title).includes(n)))
  );
};

export const createWorkspace = (data: { tasks: Task[]; projects: Project[]; tags: Tag[] }): Workspace => {
  const activeProjects = data.projects.filter((p) => !p.isArchived);
  const realTags = data.tags.filter((t) => t.id !== TODAY_TAG_ID);
  const projectById = new Map(data.projects.map((p) => [p.id, p]));
  const tagById = new Map(data.tags.map((t) => [t.id, t]));

  return {
    tasks: data.tasks,
    projects: activeProjects,
    tags: realTags,
    taskById: new Map(data.tasks.map((t) => [t.id, t])),
    findProject: (nameOrId) => findByName(activeProjects, nameOrId),
    findTag: (nameOrId) => findByName(realTags, nameOrId),
    projectTitle: (id) => (id ? (projectById.get(id)?.title ?? null) : null),
    tagTitle: (id) => tagById.get(id)?.title ?? null,
  };
};

export const loadWorkspace = async (api: PluginDataApi): Promise<Workspace> => {
  const [tasks, projects, tags] = await Promise.all([api.getTasks(), api.getAllProjects(), api.getAllTags()]);
  return createWorkspace({ tasks, projects, tags });
};

export interface SerializedTask {
  ref: string;
  title: string;
  project?: string;
  tags?: string[];
  dueDay?: string;
  estimateMin?: number;
  spentMin?: number;
  isDone?: true;
  parent?: string;
  subtasks?: number;
  notes?: string;
}

const MIN = 60000;

/** Compact, model-friendly representation of a task. */
export const serializeTask = (task: Task, ws: Workspace, refs: RefRegistry): SerializedTask => {
  const out: SerializedTask = { ref: refs.refFor(task.id), title: task.title };
  const project = ws.projectTitle(task.projectId);
  if (project) out.project = project;
  const tags = task.tagIds
    .filter((id) => id !== TODAY_TAG_ID)
    .map((id) => ws.tagTitle(id))
    .filter((t): t is string => t !== null);
  if (tags.length) out.tags = tags;
  const due = taskDueDay(task);
  if (due) out.dueDay = due;
  if (task.timeEstimate) out.estimateMin = Math.round(task.timeEstimate / MIN);
  if (task.timeSpent) out.spentMin = Math.round(task.timeSpent / MIN);
  if (task.isDone) out.isDone = true;
  if (task.parentId) {
    const parent = ws.taskById.get(task.parentId);
    if (parent) out.parent = `${refs.refFor(parent.id)} ${parent.title}`;
  }
  if (task.subTaskIds.length) out.subtasks = task.subTaskIds.length;
  if (task.notes) out.notes = truncate(task.notes, 160);
  return out;
};
