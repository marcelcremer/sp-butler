import type { AssistantMessage, ChatMessage, LlmClient, ToolDefinition } from '../src/plugin/llm-client.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/plugin/settings.ts';
import type { PluginCreateTaskData, PluginDataApi, Project, Tag, Task } from '../src/types/plugin-api.ts';

/** Wednesday, 2026-09-30, 10:00 local time. */
export const NOW = new Date(2026, 8, 30, 10, 0);

export const task = (partial: Partial<Task> & Pick<Task, 'id' | 'title'>): Task => ({
  notes: '',
  timeEstimate: 0,
  timeSpent: 0,
  isDone: false,
  projectId: null,
  tagIds: [],
  parentId: null,
  created: 0,
  subTaskIds: [],
  dueDay: null,
  dueWithTime: null,
  ...partial,
});

export const fixture = (): { tasks: Task[]; projects: Project[]; tags: Tag[] } => ({
  projects: [
    { id: 'INBOX', title: 'Inbox' },
    { id: 'p-auto', title: 'Auto & Werkstatt' },
    { id: 'p-haus', title: 'Haushalt' },
    { id: 'p-old', title: 'Altprojekt', isArchived: true },
  ],
  tags: [
    { id: 'TODAY', title: 'Today' },
    { id: 'tag-einkauf', title: 'einkaufen' },
    { id: 'tag-dringend', title: 'dringend' },
  ],
  tasks: [
    task({ id: 'a1', title: 'Milch kaufen', projectId: 'p-haus', tagIds: ['tag-einkauf'], dueDay: '2026-09-30', created: 1 }),
    task({ id: 'a2', title: 'Brot kaufen', projectId: 'p-haus', tagIds: ['tag-einkauf'], dueDay: '2026-09-30', created: 2 }),
    task({ id: 'a3', title: 'Waschmittel besorgen', projectId: 'p-haus', tagIds: ['tag-einkauf'], created: 3 }),
    task({
      id: 'a4',
      title: 'TÜV Termin',
      projectId: 'p-auto',
      dueWithTime: new Date(2026, 8, 30, 14, 30).getTime(),
      timeEstimate: 60 * 60000,
      created: 4,
    }),
    task({ id: 'a5', title: 'Steuer', projectId: 'INBOX', dueDay: '2026-10-05', subTaskIds: ['a6'], created: 5 }),
    task({ id: 'a6', title: 'Belege sammeln', projectId: 'INBOX', parentId: 'a5', dueDay: '2026-10-03', created: 6 }),
    task({ id: 'a7', title: 'Ölwechsel', projectId: 'p-auto', isDone: true, dueDay: '2026-09-20', created: 7 }),
  ],
});

export interface FakeApi extends PluginDataApi {
  calls: { method: string; args: unknown[] }[];
}

/** In-memory PluginDataApi that records every write. */
export const fakeApi = (data = fixture()): FakeApi => {
  const calls: FakeApi['calls'] = [];
  let n = 0;
  return {
    calls,
    getTasks: () => Promise.resolve(data.tasks),
    getAllProjects: () => Promise.resolve(data.projects),
    getAllTags: () => Promise.resolve(data.tags),
    addTask: (t: PluginCreateTaskData) => {
      calls.push({ method: 'addTask', args: [t] });
      return Promise.resolve(`new-task-${String(++n)}`);
    },
    updateTask: (id: string, u: Partial<Task>) => {
      calls.push({ method: 'updateTask', args: [id, u] });
      return Promise.resolve();
    },
    addProject: (p: Partial<Project>) => {
      calls.push({ method: 'addProject', args: [p] });
      return Promise.resolve(`new-project-${String(++n)}`);
    },
    addTag: (t: Partial<Tag>) => {
      calls.push({ method: 'addTag', args: [t] });
      return Promise.resolve(`new-tag-${String(++n)}`);
    },
  };
};

export const settings = (partial: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  chatModel: 'test-model',
  ...partial,
});

export interface ScriptedLlm extends LlmClient {
  requests: { messages: ChatMessage[]; tools?: ToolDefinition[] }[];
}

/**
 * LLM fake that replays scripted assistant messages. A step may be a function
 * of the messages sent so far, to react to tool results.
 */
export const scriptedLlm = (
  steps: (AssistantMessage | ((messages: ChatMessage[]) => AssistantMessage))[],
): ScriptedLlm => {
  const requests: ScriptedLlm['requests'] = [];
  return {
    requests,
    chat(req) {
      requests.push(req);
      const step = steps.shift();
      if (!step) throw new Error('scriptedLlm: no more steps');
      return Promise.resolve(typeof step === 'function' ? step(req.messages) : step);
    },
    embed: () => Promise.reject(new Error('not scripted')),
    rerank: () => Promise.reject(new Error('not scripted')),
    listModels: () => Promise.resolve(['test-model']),
  };
};

let callCounter = 0;
export const toolCall = (name: string, args: unknown): AssistantMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    { id: `call-${String(++callCounter)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ],
});

export const say = (content: string): AssistantMessage => ({ role: 'assistant', content });

/** Parses the JSON content of the last tool message. */
export const lastToolResult = (messages: ChatMessage[]): unknown => {
  const last = [...messages].reverse().find((m) => m.role === 'tool');
  if (!last) throw new Error('no tool message');
  return JSON.parse(last.content);
};
