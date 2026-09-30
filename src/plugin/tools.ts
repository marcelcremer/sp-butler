// Tool definitions (OpenAI function-calling format) and their executors.
//
// Read tools run immediately. Write tools never touch data: they validate the
// request, resolve names/refs and add items to a proposal that the UI shows
// for confirmation (see proposal.ts).

import type { Task } from '../types/plugin-api.ts';
import { isDayStr, parseDayStr, taskDueDay, toDayStr } from './dates.ts';
import type { LlmClient, ToolDefinition } from './llm-client.ts';
import type { CreateSpec, DiffRow, Proposal, UpdateItem } from './proposal.ts';
import { applyFilters, rankTasks, type EmbeddingIndex, type TaskFilter } from './search.ts';
import type { Settings } from './settings.ts';
import {
  normalizeName,
  serializeTask,
  TODAY_TAG_ID,
  truncate,
  type RefRegistry,
  type SerializedTask,
  type Workspace,
} from './workspace.ts';

const dayParam = (description: string): Record<string, unknown> => ({
  type: ['string', 'null'],
  description: `${description} Format YYYY-MM-DD, null = kein Datum.`,
});

const TASK_FIELDS = {
  title: { type: 'string', description: 'Kurzer, prägnanter Titel (ohne Datum/Projekt/Dauer).' },
  project: { type: 'string', description: 'Projektname (bestehende bevorzugen). Neuer Name legt das Projekt an.' },
  tags: { type: 'array', items: { type: 'string' }, description: 'Tag-Namen. Unbekannte werden angelegt.' },
  notes: { type: 'string', description: 'Notizen/Details (Markdown).' },
  estimateMinutes: { type: 'number', description: 'Zeitschätzung in Minuten.' },
  dueDay: dayParam('Fälligkeitstag.'),
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_tasks',
      description:
        'Sucht Tasks mit Filtern und optionaler (semantischer) Freitextsuche. Liefert Tasks mit kurzer Referenz (ref), ' +
        'die für Änderungen verwendet wird. Vor jeder Änderung bestehender Tasks zuerst suchen.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Freitext, z.B. "Einkaufen". Weglassen für reine Filter.' },
          project: { type: 'string', description: 'Projektname oder -id.' },
          tag: { type: 'string', description: 'Tag-Name oder -id.' },
          dueFrom: { type: 'string', description: 'Fällig ab (inklusive), YYYY-MM-DD.' },
          dueTo: { type: 'string', description: 'Fällig bis (inklusive), YYYY-MM-DD. "Überfällig" = bis gestern.' },
          noDueDay: { type: 'boolean', description: 'Nur Tasks ohne Fälligkeit.' },
          status: { type: 'string', enum: ['open', 'done', 'all'], description: 'Standard: open.' },
          includeSubtasks: { type: 'boolean', description: 'Standard: true.' },
          limit: { type: 'number', description: 'Maximale Anzahl (Standard 40, höchstens 150).' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task',
      description: 'Details eines Tasks inklusive vollständiger Notizen und Subtasks.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_create_tasks',
      description:
        'Schlägt neue Tasks (optional mit Subtasks) vor. Der Nutzer bestätigt, bevor sie angelegt werden. ' +
        'Für Brain-Dumps: sinnvoll gruppieren, zusammengehörige Schritte als Subtasks.',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ...TASK_FIELDS,
                parentRef: {
                  type: 'string',
                  description: 'ref eines bestehenden Tasks, wenn der neue Task dessen Subtask werden soll.',
                },
                subtasks: {
                  type: 'array',
                  description: 'Subtasks (nur eine Ebene).',
                  items: {
                    type: 'object',
                    properties: {
                      title: TASK_FIELDS.title,
                      notes: TASK_FIELDS.notes,
                      estimateMinutes: TASK_FIELDS.estimateMinutes,
                      dueDay: TASK_FIELDS.dueDay,
                      tags: TASK_FIELDS.tags,
                    },
                    required: ['title'],
                  },
                },
              },
              required: ['title'],
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_update_tasks',
      description:
        'Schlägt Änderungen an bestehenden Tasks vor: verschieben, erledigen, umbenennen, taggen, Projekt wechseln usw. ' +
        'Nur angegebene Felder werden geändert. Der Nutzer bestätigt vor der Ausführung.',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: 'ref aus search_tasks.' },
                title: { type: 'string' },
                notes: { type: 'string', description: 'Ersetzt die Notizen vollständig.' },
                appendNotes: { type: 'string', description: 'Wird an die bestehenden Notizen angehängt.' },
                estimateMinutes: { type: 'number', description: '0 entfernt die Schätzung.' },
                dueDay: dayParam('Neuer Fälligkeitstag.'),
                isDone: { type: 'boolean' },
                project: { type: 'string', description: 'In dieses bestehende Projekt verschieben.' },
                addTags: { type: 'array', items: { type: 'string' } },
                removeTags: { type: 'array', items: { type: 'string' } },
              },
              required: ['ref'],
            },
          },
        },
        required: ['changes'],
        additionalProperties: false,
      },
    },
  },
];

export interface ToolContext {
  ws: Workspace;
  refs: RefRegistry;
  llm: Pick<LlmClient, 'rerank'>;
  settings: Pick<Settings, 'embeddingModel' | 'rerankModel'>;
  embeddingIndex?: EmbeddingIndex;
  proposal: Proposal;
  log?: (msg: string) => void;
}

export type ToolExecutor = (name: string, rawArgs: string) => Promise<unknown>;

class ToolInputError extends Error {}

// --- argument helpers: tool arguments are untrusted model output ------------

type Args = Record<string, unknown>;

const isArgs = (v: unknown): v is Args => typeof v === 'object' && v !== null && !Array.isArray(v);

const optString = (a: Args, key: string): string | undefined => {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`${key} muss ein String sein.`);
  return v;
};

const optNumber = (a: Args, key: string): number | undefined => {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolInputError(`${key} muss eine Zahl sein.`);
  return n;
};

const optBool = (a: Args, key: string): boolean | undefined => {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolInputError(`${key} muss true/false sein.`);
  return v;
};

const stringList = (a: Args, key: string): string[] => {
  const v = a[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new ToolInputError(`${key} muss eine Liste von Strings sein.`);
  }
  return v.map((s) => s.trim()).filter(Boolean);
};

const objectList = (a: Args, key: string): Args[] => {
  const v = a[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every(isArgs)) throw new ToolInputError(`${key} muss eine Liste von Objekten sein.`);
  return v;
};

/** undefined = not given, null = clear, string = valid day. */
const optDay = (a: Args, key: string): string | null | undefined => {
  if (!(key in a)) return undefined;
  const v = a[key];
  if (v === null || v === '') return null;
  if (!isDayStr(v)) throw new ToolInputError(`Ungültiges Datum für ${key}: ${JSON.stringify(v)} – erwartet YYYY-MM-DD.`);
  return v;
};

// ---------------------------------------------------------------------------

export const createToolExecutor = (ctx: ToolContext): ToolExecutor => {
  const handlers: Record<string, (args: Args) => unknown> = {
    search_tasks: (args) => searchTasks(ctx, args),
    get_task: (args) => getTask(ctx, args),
    propose_create_tasks: (args) => proposeCreate(ctx, args),
    propose_update_tasks: (args) => proposeUpdate(ctx, args),
  };
  return async (name, rawArgs) => {
    const handler = handlers[name];
    if (!handler) return { error: `Unbekanntes Tool: ${name}` };
    let args: unknown;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { error: 'Argumente sind kein gültiges JSON.' };
    }
    if (!isArgs(args)) return { error: 'Argumente müssen ein JSON-Objekt sein.' };
    try {
      return await handler(args);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
};

// --- read tools -------------------------------------------------------------

const MIN = 60000;

const compareByDue = (a: Task, b: Task): number =>
  (taskDueDay(a) ?? '9999').localeCompare(taskDueDay(b) ?? '9999') || a.created - b.created;

const searchTasks = async (ctx: ToolContext, args: Args): Promise<unknown> => {
  const { ws, refs } = ctx;
  const status = optString(args, 'status');
  if (status !== undefined && status !== 'open' && status !== 'done' && status !== 'all') {
    throw new ToolInputError('status muss open, done oder all sein.');
  }
  const filter: TaskFilter = {
    project: optString(args, 'project'),
    tag: optString(args, 'tag'),
    dueFrom: optDay(args, 'dueFrom') ?? undefined,
    dueTo: optDay(args, 'dueTo') ?? undefined,
    noDueDay: optBool(args, 'noDueDay'),
    status,
    includeSubtasks: optBool(args, 'includeSubtasks'),
  };
  const filtered = applyFilters(ws.tasks, ws, filter);
  if ('error' in filtered) {
    return {
      error: filtered.error,
      knownProjects: ws.projects.map((p) => p.title),
      knownTags: ws.tags.map((t) => t.title),
    };
  }

  const limit = Math.min(Math.max(Math.round(optNumber(args, 'limit') ?? 40), 1), 150);
  const query = optString(args, 'query')?.trim();
  let list = filtered.tasks;
  const result: {
    total?: number;
    shown?: number;
    totalEstimateMin?: number;
    rankedBy?: string[];
    note?: string;
    truncated?: true;
    tasks?: SerializedTask[];
  } = {};

  if (query) {
    const { ranked, methods } = await rankTasks({ ...ctx, tasks: list, query });
    result.rankedBy = methods;
    if (methods.length === 1) {
      // Keyword only: drop non-matches. If nothing matches, hand the model the
      // filtered list – it is a decent semantic matcher itself.
      const hits = ranked.filter((r) => r.score > 0);
      list = (hits.length ? hits : ranked).map((r) => r.task);
      if (!hits.length) {
        result.note = 'Kein Stichwort-Treffer; ungefilterte Liste – passende Tasks bitte selbst auswählen.';
      }
    } else {
      list = ranked.map((r) => r.task);
      result.note = 'Nach Relevanz sortiert; nicht jeder Treffer ist relevant – selbst prüfen.';
    }
  } else {
    list = [...list].sort(compareByDue);
  }

  const shown = list.slice(0, limit);
  result.total = list.length;
  result.shown = shown.length;
  result.totalEstimateMin = Math.round(list.reduce((sum, t) => sum + t.timeEstimate, 0) / MIN);
  if (list.length > shown.length) result.truncated = true;
  result.tasks = shown.map((t) => serializeTask(t, ws, refs));
  return result;
};

const resolveRef = (ctx: ToolContext, ref: string | undefined): Task => {
  if (!ref) throw new ToolInputError('ref fehlt.');
  const id = ctx.refs.idFor(ref);
  const task = id ? ctx.ws.taskById.get(id) : undefined;
  if (!task) throw new ToolInputError(`Unbekannte ref "${ref}". Zuerst search_tasks aufrufen.`);
  return task;
};

const getTask = (ctx: ToolContext, args: Args): unknown => {
  const task = resolveRef(ctx, optString(args, 'ref'));
  return {
    ...serializeTask(task, ctx.ws, ctx.refs),
    notes: task.notes ?? '',
    subtasks: task.subTaskIds
      .map((id) => ctx.ws.taskById.get(id))
      .filter((t): t is Task => t !== undefined)
      .map((t) => serializeTask(t, ctx.ws, ctx.refs)),
  };
};

// --- write tools (proposal only) ------------------------------------------

const resolveTags = (
  ctx: ToolContext,
  names: string[],
): { tagIds: string[]; newTags: string[]; labels: string[] } => {
  const tagIds: string[] = [];
  const newTags: string[] = [];
  const labels: string[] = [];
  for (const name of names) {
    const tag = ctx.ws.findTag(name);
    if (tag) {
      if (!tagIds.includes(tag.id)) {
        tagIds.push(tag.id);
        labels.push(tag.title);
      }
      continue;
    }
    const clean = name.replace(/^#/, '');
    if (!newTags.some((n) => normalizeName(n) === normalizeName(clean))) {
      newTags.push(clean);
      labels.push(`${clean} (neu)`);
    }
  }
  return { tagIds, newTags, labels };
};

const estimateMs = (min: number | undefined): number | undefined => {
  if (min === undefined) return undefined;
  if (min < 0) throw new ToolInputError(`Ungültige Zeitschätzung: ${min}`);
  return Math.round(min) * MIN;
};

interface ProjectChoice {
  projectId?: string | null;
  newProject?: string;
  label?: string;
}

const buildCreateSpec = (ctx: ToolContext, raw: Args, project: ProjectChoice): CreateSpec => {
  const title = optString(raw, 'title')?.trim();
  if (!title) throw new ToolInputError('Task ohne Titel.');
  const tags = resolveTags(ctx, stringList(raw, 'tags'));
  const notes = optString(raw, 'notes')?.trim() || undefined;
  const estimateMin = optNumber(raw, 'estimateMinutes');
  const dueDay = optDay(raw, 'dueDay');
  return {
    title,
    projectId: project.projectId,
    newProject: project.newProject,
    tagIds: tags.tagIds,
    newTags: tags.newTags,
    notes,
    timeEstimate: estimateMs(estimateMin),
    dueDay,
    subtasks: [],
    display: {
      title,
      project: project.label,
      tags: tags.labels,
      estimateMin: estimateMin ? Math.round(estimateMin) : undefined,
      dueDay: dueDay ?? undefined,
      notes: notes ? truncate(notes, 200) : undefined,
    },
  };
};

const chooseProject = (ctx: ToolContext, name: string | undefined): ProjectChoice => {
  if (!name?.trim()) return {};
  const p = ctx.ws.findProject(name);
  if (p) return { projectId: p.id, label: p.title };
  return { newProject: name.trim(), label: `${name.trim()} (neu)` };
};

const proposeCreate = (ctx: ToolContext, args: Args): unknown => {
  const rawTasks = objectList(args, 'tasks');
  if (!rawTasks.length) throw new ToolInputError('tasks ist leer.');
  const items: CreateSpec[] = [];
  for (const raw of rawTasks) {
    const parentRef = optString(raw, 'parentRef');
    const rawSubs = objectList(raw, 'subtasks');
    if (parentRef) {
      const parent = resolveRef(ctx, parentRef);
      if (parent.parentId) throw new ToolInputError('Subtasks können keine eigenen Subtasks haben.');
      if (rawSubs.length) throw new ToolInputError('Ein neuer Subtask kann keine Subtasks haben.');
      const spec = buildCreateSpec(ctx, raw, { projectId: parent.projectId });
      spec.parentId = parent.id;
      spec.display.parent = parent.title;
      items.push(spec);
      continue;
    }
    const project = chooseProject(ctx, optString(raw, 'project'));
    const spec = buildCreateSpec(ctx, raw, project);
    // Subtasks always live in their parent's project.
    spec.subtasks = rawSubs.map((s) => buildCreateSpec(ctx, s, {}));
    items.push(spec);
  }
  return {
    status: 'proposed',
    items: ctx.proposal.add(items.map((spec) => ({ kind: 'create', ...spec }))),
    info: 'Wird dem Nutzer zur Bestätigung angezeigt – noch NICHT angelegt.',
  };
};

const proposeUpdate = (ctx: ToolContext, args: Args): unknown => {
  const rawChanges = objectList(args, 'changes');
  if (!rawChanges.length) throw new ToolInputError('changes ist leer.');
  const items: UpdateItem[] = [];
  const errors: { ref: unknown; error: string }[] = [];
  for (const raw of rawChanges) {
    try {
      items.push(buildUpdateItem(ctx, raw));
    } catch (e) {
      errors.push({ ref: raw.ref, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    status: items.length ? 'proposed' : 'nothing proposed',
    items: items.length ? ctx.proposal.add(items) : [],
    ...(items.length ? { info: 'Wird dem Nutzer zur Bestätigung angezeigt – noch NICHT ausgeführt.' } : {}),
    ...(errors.length ? { errors } : {}),
  };
};

const fmtMin = (ms: number | undefined): string => (ms ? `${Math.round(ms / MIN)} min` : '–');

/**
 * Rescheduling keeps a task's time of day if it has one; plain-day tasks only
 * get the new dueDay.
 */
export const dueUpdates = (task: Pick<Task, 'dueWithTime'>, newDue: string | null): Partial<Task> => {
  if (newDue === null) return { dueDay: null, dueWithTime: null };
  if (task.dueWithTime) {
    const old = new Date(task.dueWithTime);
    const d = parseDayStr(newDue);
    d.setHours(old.getHours(), old.getMinutes(), 0, 0);
    return { dueDay: toDayStr(d), dueWithTime: d.getTime() };
  }
  return { dueDay: newDue };
};

const buildUpdateItem = (ctx: ToolContext, raw: Args): UpdateItem => {
  const { ws } = ctx;
  const task = resolveRef(ctx, optString(raw, 'ref'));
  const updates: Partial<Task> = {};
  const diff: DiffRow[] = [];

  const title = optString(raw, 'title')?.trim();
  if (title && title !== task.title) {
    updates.title = title;
    diff.push(['Titel', task.title, title]);
  }

  const notes = optString(raw, 'notes');
  if (notes !== undefined) {
    updates.notes = notes;
    diff.push(['Notizen', truncate(task.notes ?? '–', 60), truncate(notes || '–', 60)]);
  }
  const appendNotes = optString(raw, 'appendNotes')?.trim();
  if (appendNotes) {
    updates.notes = [updates.notes ?? task.notes ?? '', appendNotes].filter(Boolean).join('\n\n');
    diff.push(['Notizen', '…', `+ ${truncate(appendNotes, 60)}`]);
  }

  const estimate = optNumber(raw, 'estimateMinutes');
  if (estimate !== undefined) {
    updates.timeEstimate = estimateMs(estimate) ?? 0;
    diff.push(['Schätzung', fmtMin(task.timeEstimate), fmtMin(updates.timeEstimate)]);
  }

  const newDue = optDay(raw, 'dueDay');
  const oldDue = taskDueDay(task);
  if (newDue !== undefined && newDue !== oldDue) {
    Object.assign(updates, dueUpdates(task, newDue));
    diff.push(['Fällig', oldDue ?? '–', newDue ?? '–']);
  }

  const isDone = optBool(raw, 'isDone');
  if (isDone !== undefined && isDone !== task.isDone) {
    updates.isDone = isDone;
    updates.doneOn = isDone ? Date.now() : null;
    diff.push(['Status', task.isDone ? 'erledigt' : 'offen', isDone ? 'erledigt' : 'offen']);
  }

  const projectName = optString(raw, 'project');
  if (projectName) {
    const p = ws.findProject(projectName);
    if (!p) throw new ToolInputError(`Projekt "${projectName}" nicht gefunden (Verschieben nur in bestehende Projekte).`);
    if (p.id !== task.projectId) {
      if (task.parentId) throw new ToolInputError('Subtasks können nicht einzeln verschoben werden.');
      updates.projectId = p.id;
      diff.push(['Projekt', ws.projectTitle(task.projectId) ?? '–', p.title]);
    }
  }

  let newTags: string[] = [];
  const addTags = stringList(raw, 'addTags');
  const removeTags = stringList(raw, 'removeTags');
  if (addTags.length || removeTags.length) {
    const before = task.tagIds;
    const next = new Set(before);
    const added = resolveTags(ctx, addTags);
    added.tagIds.forEach((id) => next.add(id));
    for (const name of removeTags) {
      const tag = ws.findTag(name);
      if (tag) next.delete(tag.id);
    }
    newTags = added.newTags;
    const after = [...next];
    if (newTags.length || after.length !== before.length || after.some((id) => !before.includes(id))) {
      updates.tagIds = after;
      const label = (ids: string[]): string[] =>
        ids.filter((id) => id !== TODAY_TAG_ID).map((id) => ws.tagTitle(id) ?? id);
      diff.push([
        'Tags',
        label(before).join(', ') || '–',
        [...label(after), ...newTags.map((n) => `${n} (neu)`)].join(', ') || '–',
      ]);
    }
  }

  if (!diff.length) throw new ToolInputError(`Keine Änderung für "${task.title}".`);
  return {
    kind: 'update',
    taskId: task.id,
    updates,
    newTags,
    display: { title: task.title, project: ws.projectTitle(task.projectId) ?? undefined, diff },
  };
};
