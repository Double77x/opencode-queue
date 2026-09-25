import type { Task } from "./task.ts";
import { isRecord, parseJson, readCount, readString } from "../utils/json.ts";

export const DEFAULT_BUDGET = 10;
export const MAX_BUDGET = 50;

export type Arming = {
  sessionID: string;
  budget: number;
  used: number;
  activeID: string;
  paused: boolean;
};

export type StopReason = "paused" | "budget" | "empty" | "unfinished";

export type Decision =
  | { kind: "inactive" }
  | { kind: "stop"; reason: StopReason }
  | { kind: "run"; taskID: string; taskText: string; next: Arming };

/**
 * This file authorises unattended model turns, so it is parsed fail-closed: any
 * document that cannot be fully understood is treated as *off*. A hand-edited
 * or truncated file must never be read as consent to spend tokens.
 */
export function parseArming(raw: string): Arming | undefined {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return undefined;
  const sessionID = readString(parsed, "sessionID");
  if (sessionID.length === 0) return undefined;
  if (typeof parsed.activeID !== "string") return undefined;
  if (typeof parsed.paused !== "boolean") return undefined;
  const budget = readCount(parsed, "budget", MAX_BUDGET);
  return {
    sessionID,
    budget: budget === 0 ? DEFAULT_BUDGET : budget,
    used: readCount(parsed, "used", MAX_BUDGET),
    activeID: parsed.activeID,
    paused: parsed.paused,
  };
}

export function freshArming(sessionID: string): Arming {
  return { sessionID, budget: DEFAULT_BUDGET, used: 0, activeID: "", paused: false };
}

export function isArmedFor(arming: Arming | undefined, sessionID: string): arming is Arming {
  return arming !== undefined && arming.sessionID === sessionID;
}

/** Toggle without a verb: arm this session, or disarm it if already armed. */
export function toggled(arming: Arming | undefined, sessionID: string): Arming | undefined {
  if (isArmedFor(arming, sessionID)) return undefined;
  return freshArming(sessionID);
}

export function remaining(arming: Arming): number {
  return Math.max(0, arming.budget - arming.used);
}

/**
 * Decides what to do when a session falls idle.
 *
 * `unfinished` is the load-bearing branch: if a task was handed over and the
 * agent never ticked it off, resubmitting the same text would loop forever, so
 * the run stops instead.
 */
export function decideNext(arming: Arming | undefined, sessionID: string, pending: readonly Task[]): Decision {
  if (!isArmedFor(arming, sessionID)) return { kind: "inactive" };
  if (arming.paused) return { kind: "stop", reason: "paused" };
  if (arming.used >= arming.budget) return { kind: "stop", reason: "budget" };
  const head = pending[0];
  if (head === undefined) return { kind: "stop", reason: "empty" };
  if (arming.activeID.length > 0 && pending.some((task) => task.id === arming.activeID)) {
    return { kind: "stop", reason: "unfinished" };
  }
  return {
    kind: "run",
    taskID: head.id,
    taskText: head.text,
    next: { ...arming, used: arming.used + 1, activeID: head.id },
  };
}

export function describeStop(reason: StopReason): string {
  switch (reason) {
    case "paused":
      return "auto-run is paused";
    case "budget":
      return "auto-run has used its full task budget";
    case "empty":
      return "no pending tasks";
    case "unfinished":
      return "the previous task was never marked complete";
  }
}

export function statusText(arming: Arming | undefined): string {
  if (arming === undefined) return "Auto-run is off for this session.";
  if (arming.paused) return "Auto-run is paused. Run /queue-auto to re-arm it.";
  if (remaining(arming) === 0) return "Auto-run has used its full task budget. Run /queue-auto to re-arm it.";
  return `Auto-run is on. ${remaining(arming)} of ${arming.budget} task turns left. Run /queue-auto to turn it off.`;
}

export function badgeText(arming: Arming | undefined): string | undefined {
  if (arming === undefined) return undefined;
  if (arming.paused) return "auto-run paused";
  return `auto-run ${arming.used}/${arming.budget}`;
}
