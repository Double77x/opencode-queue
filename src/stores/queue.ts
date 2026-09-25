import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../libs/lock.ts";
import { watchFile } from "../libs/watcher.ts";
import { DONE, PENDING, type Task, type TaskStatus, toTask } from "../core/task.ts";
import { writeAtomic } from "../utils/fs.ts";
import { parseJson } from "../utils/json.ts";

const FILE_NAME = "queue.json";

export class QueueUnreadableError extends Error {
  override name = "QueueUnreadableError";
  readonly file: string;
  readonly raw: string;
  constructor(file: string, raw: string) {
    super(`The queue file at ${file} is not readable. It was moved aside and not overwritten.`);
    this.file = file;
    this.raw = raw;
  }
}

/** Thrown when a picker acted on a task that another window already changed. */
export class TaskChangedError extends Error {
  override name = "TaskChangedError";
  constructor() {
    super("That task changed in another OpenCode window. Reopen it and try again.");
  }
}

export class QueueBusyError extends Error {
  override name = "QueueBusyError";
  constructor() {
    super("Another OpenCode window is holding the queue lock. Try again in a moment.");
  }
}

export function queueFile(worktree: string): string {
  return path.join(worktree, ".opencode", FILE_NAME);
}

function commit(file: string, tasks: Task[]): Promise<void> {
  return writeAtomic(file, `${JSON.stringify(tasks, null, 2)}\n`);
}

/** Moves an unparseable file aside so the next write starts from a clean slate. */
async function quarantine(file: string): Promise<void> {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  await rename(file, `${file}.corrupt-${stamp}`).catch(() => undefined);
}

async function readTasks(file: string): Promise<Task[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    await quarantine(file);
    throw new QueueUnreadableError(file, raw);
  }
  // Any record that fails validation invalidates the whole document. Dropping
  // the bad record would silently lose a task the user believed was saved.
  const tasks = parsed.map(toTask);
  const ids = new Set(tasks.map((task) => task?.id));
  if (tasks.some((task) => task === undefined) || ids.size !== tasks.length) {
    await quarantine(file);
    throw new QueueUnreadableError(file, raw);
  }
  return tasks as Task[];
}

type Mutation<T> = { tasks: Task[]; value: T; changed: boolean };

async function transact<T>(worktree: string, recipe: (tasks: Task[]) => Promise<Mutation<T>>): Promise<T> {
  const file = queueFile(worktree);
  try {
    return await withFileLock(file, async () => {
      const result = await recipe(await readTasks(file));
      if (result.changed) await commit(file, result.tasks);
      return result.value;
    });
  } catch (error) {
    if (error instanceof Error && error.name === "LockTimeoutError") throw new QueueBusyError();
    throw error;
  }
}

export async function loadAll(worktree: string): Promise<Task[]> {
  return readTasks(queueFile(worktree));
}

export async function load(worktree: string, sessionID: string): Promise<Task[]> {
  return (await loadAll(worktree)).filter((task) => task.sessionID === sessionID);
}

export async function add(worktree: string, sessionID: string, text: string): Promise<Task> {
  return transact(worktree, async (tasks) => {
    const task: Task = {
      id: randomUUID().slice(0, 12),
      sessionID,
      text,
      createdAt: new Date().toISOString(),
      status: PENDING,
    };
    return { tasks: [...tasks, task], value: task, changed: true };
  });
}

export async function edit(worktree: string, id: string, text: string, expected?: Task): Promise<Task | undefined> {
  return transact(worktree, async (tasks) => {
    const index = tasks.findIndex((task) => task.id === id);
    const current = tasks[index];
    if (current === undefined) return { tasks, value: undefined, changed: false };
    assertUnchanged(expected, current);
    const next = [...tasks];
    next[index] = { ...current, text, status: PENDING };
    return { tasks: next, value: next[index] as Task, changed: true };
  });
}

export async function remove(worktree: string, id: string, expected?: Task): Promise<Task | undefined> {
  return transact(worktree, async (tasks) => {
    const current = tasks.find((task) => task.id === id);
    if (current === undefined) return { tasks, value: undefined, changed: false };
    assertUnchanged(expected, current);
    return { tasks: tasks.filter((task) => task.id !== id), value: current, changed: true };
  });
}

export async function setStatus(
  worktree: string,
  id: string,
  status: TaskStatus,
  expected?: Task,
): Promise<Task | undefined> {
  return transact(worktree, async (tasks) => {
    const index = tasks.findIndex((task) => task.id === id);
    const current = tasks[index];
    if (current === undefined) return { tasks, value: undefined, changed: false };
    assertUnchanged(expected, current);
    if (current.status === status) return { tasks, value: current, changed: false };
    const next = [...tasks];
    next[index] = { ...current, status };
    return { tasks: next, value: next[index] as Task, changed: true };
  });
}

export const complete = (worktree: string, id: string, expected?: Task): Promise<Task | undefined> =>
  setStatus(worktree, id, DONE, expected);

export const reopen = (worktree: string, id: string, expected?: Task): Promise<Task | undefined> =>
  setStatus(worktree, id, PENDING, expected);

/** Clears one session. `keep` protects tasks added after a confirm dialog opened. */
export async function clearSession(worktree: string, sessionID: string, keep?: ReadonlySet<string>): Promise<number> {
  return transact(worktree, async (tasks) => {
    const doomed = tasks.filter((task) => task.sessionID === sessionID && keep?.has(task.id) !== true);
    if (doomed.length === 0) return { tasks, value: 0, changed: false };
    const ids = new Set(doomed.map((task) => task.id));
    return { tasks: tasks.filter((task) => !ids.has(task.id)), value: doomed.length, changed: true };
  });
}

export function subscribe(
  worktree: string,
  onChange: (tasks: Task[]) => void,
  onError: (error: unknown) => void,
): () => void {
  const refresh = () => {
    loadAll(worktree).then(onChange, onError);
  };
  refresh();
  return watchFile(queueFile(worktree), refresh);
}

function assertUnchanged(expected: Task | undefined, current: Task): void {
  if (expected === undefined) return;
  if (expected.id !== current.id || expected.text !== current.text || expected.status !== current.status) {
    throw new TaskChangedError();
  }
}
