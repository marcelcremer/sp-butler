// The subset of Super Productivity's Plugin API this plugin uses.
//
// Mirrors packages/plugin-api/src/types.ts of super-productivity (MIT). The
// published npm package (@super-productivity/plugin-api 1.0.1) predates
// secret storage, so the relevant parts are kept here instead of adding a
// stale dependency.

export interface Task {
  id: string;
  title: string;
  notes?: string;
  timeEstimate: number;
  timeSpent: number;
  isDone: boolean;
  projectId: string | null;
  tagIds: string[];
  parentId?: string | null;
  created: number;
  subTaskIds: string[];
  doneOn?: number | null;
  dueDay?: string | null;
  dueWithTime?: number | null;
}

export interface Project {
  id: string;
  title: string;
  isArchived?: boolean;
}

export interface Tag {
  id: string;
  title: string;
}

export interface PluginCreateTaskData {
  title: string;
  projectId?: string | null;
  tagIds?: string[];
  notes?: string;
  timeEstimate?: number;
  parentId?: string | null;
  isDone?: boolean;
  /** YYYY-MM-DD */
  dueDay?: string | null;
}

export interface SnackCfg {
  msg: string;
  type?: 'SUCCESS' | 'ERROR' | 'WARNING' | 'INFO';
  ico?: string;
}

export interface PluginLog {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  err: (...args: unknown[]) => void;
}

/** Task/project/tag data access – available in plugin.js and in the iframe. */
export interface PluginDataApi {
  getTasks(): Promise<Task[]>;
  getAllProjects(): Promise<Project[]>;
  getAllTags(): Promise<Tag[]>;
  addTask(taskData: PluginCreateTaskData): Promise<string>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<void>;
  addProject(projectData: Partial<Project>): Promise<string>;
  addTag(tagData: Partial<Tag>): Promise<string>;
}

export interface PluginApi extends PluginDataApi {
  readonly Hooks: { PERSISTED_DATA_CHANGED: string };
  registerHook(hook: string, fn: (payload: unknown) => void): void;
  registerShortcut(cfg: { id?: string; label: string; onExec: () => void }): void;
  showIndexHtmlAsView(): void;
  showSnack(cfg: SnackCfg): void;
  onMessage?(handler: (message: unknown) => Promise<unknown>): void;
  persistDataSynced(dataStr: string, key?: string): Promise<void>;
  loadSyncedData(key?: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
  log?: PluginLog;
}
