import { DONE, PENDING, type Task, type TaskView, type TaskStatus } from "./task.ts";
import { truncate } from "../utils/text.ts";

const TICK = "✓";
const CIRCLE = "○";
const LIST_MAX_CHARS = 60;

/** Position in the full session list. Order in the file is the user's order. */
export function position(tasks: readonly Task[]): TaskView[] {
  return tasks.map((task, index) => ({ position: index + 1, task }));
}

export function pendingFirst(views: TaskView[]): TaskView[] {
  return views.toSorted((a, b) => {
    if (a.task.status === b.task.status) return 0;
    return a.task.status === PENDING ? -1 : 1;
  });
}

export function marker(status: TaskStatus): string {
  return status === DONE ? TICK : CIRCLE;
}

export function pickerLabel(entry: TaskView): string {
  const done = entry.task.status === DONE ? `${TICK} ` : "";
  return `${entry.position}. ${done}${entry.task.text}`;
}

export function listLine(entry: TaskView): string {
  return `${entry.position}. ${marker(entry.task.status)} ${truncate(entry.task.text, LIST_MAX_CHARS)}`;
}

/** Oldest first, pending before done, skipping anything already finished. */
export function nextTask(tasks: readonly Task[]): Task | undefined {
  return tasks.find((task) => task.status === PENDING);
}
