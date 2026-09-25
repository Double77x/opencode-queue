export const PENDING = "pending";
export const DONE = "done";

export type TaskStatus = typeof PENDING | typeof DONE;

export type Task = {
  id: string;
  sessionID: string;
  text: string;
  createdAt: string;
  status: TaskStatus;
};

export type TaskView = {
  position: number;
  task: Task;
};

/**
 * Anything that fails validation is quarantined rather than repaired. A task
 * record is user data; guessing at a broken field is worse than refusing it.
 */
export function toTask(value: unknown): Task | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const sessionID = record.sessionID;
  const text = record.text;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof sessionID !== "string" || sessionID.length === 0) return undefined;
  if (typeof text !== "string") return undefined;
  return {
    id,
    sessionID,
    text,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    status: record.status === DONE ? DONE : PENDING,
  };
}
