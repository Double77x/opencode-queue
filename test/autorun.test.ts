import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_BUDGET,
  MAX_BUDGET,
  badgeText,
  decideNext,
  freshArming,
  isArmedFor,
  parseArming,
  statusText,
  toggled,
} from "../src/core/autorun.ts";
import { DONE, PENDING, type Task } from "../src/core/task.ts";

const SESSION = "ses_q";

function task(id: string, status: typeof PENDING | typeof DONE = PENDING): Task {
  return { id, sessionID: SESSION, text: `task ${id}`, createdAt: "", status };
}

describe("arming parse fails closed", () => {
  const valid = { sessionID: SESSION, budget: 4, used: 1, activeID: "a", paused: false };

  test("accepts a well-formed document", () => {
    assert.deepEqual(parseArming(JSON.stringify(valid)), valid);
  });

  for (const [label, raw] of [
    ["not json", "{"],
    ["an array", "[]"],
    ["a bare number", "5"],
    ["no sessionID", JSON.stringify({ budget: 1, used: 0, activeID: "", paused: false })],
    ["a non-string sessionID", JSON.stringify({ ...valid, sessionID: 7 })],
    ["no activeID", JSON.stringify({ sessionID: SESSION, budget: 1, used: 0, paused: false })],
    ["a non-boolean paused", JSON.stringify({ ...valid, paused: "no" })],
  ] as const) {
    test(`refuses ${label}`, () => {
      assert.equal(parseArming(raw), undefined);
    });
  }

  test("clamps a hand-edited budget", () => {
    assert.equal(parseArming(JSON.stringify({ ...valid, budget: 10_000 }))?.budget, MAX_BUDGET);
  });

  test("falls back to the default budget when the value is nonsense", () => {
    assert.equal(parseArming(JSON.stringify({ ...valid, budget: -3 }))?.budget, DEFAULT_BUDGET);
  });

  test("refuses a negative count", () => {
    assert.equal(parseArming(JSON.stringify({ ...valid, used: -1 }))?.used, 0);
  });
});

describe("arming scope", () => {
  test("is only armed for the session that asked for it", () => {
    const arming = freshArming(SESSION);
    assert.equal(isArmedFor(arming, SESSION), true);
    assert.equal(isArmedFor(arming, "ses_other"), false);
    assert.equal(isArmedFor(undefined, SESSION), false);
  });

  test("toggling twice returns to disarmed", () => {
    const once = toggled(undefined, SESSION);
    assert.ok(once);
    assert.equal(toggled(once, SESSION), undefined);
  });

  test("toggling from another session arms the new one", () => {
    assert.equal(toggled(freshArming("ses_other"), SESSION)?.sessionID, SESSION);
  });
});

describe("decideNext", () => {
  test("does nothing when not armed", () => {
    assert.deepEqual(decideNext(undefined, SESSION, [task("a")]), { kind: "inactive" });
  });

  test("does nothing for a session that did not opt in", () => {
    assert.deepEqual(decideNext(freshArming("ses_other"), SESSION, [task("a")]), { kind: "inactive" });
  });

  test("runs the oldest pending task and records it as active", () => {
    const decision = decideNext(freshArming(SESSION), SESSION, [task("a"), task("b")]);
    assert.equal(decision.kind, "run");
    if (decision.kind !== "run") return;
    assert.equal(decision.taskID, "a");
    assert.equal(decision.taskText, "task a");
    assert.equal(decision.next.activeID, "a");
    assert.equal(decision.next.used, 1);
  });

  test("stops when nothing is pending", () => {
    assert.deepEqual(decideNext(freshArming(SESSION), SESSION, []), { kind: "stop", reason: "empty" });
  });

  test("stops once the budget is spent", () => {
    const spent = { ...freshArming(SESSION), used: DEFAULT_BUDGET };
    assert.deepEqual(decideNext(spent, SESSION, [task("a")]), { kind: "stop", reason: "budget" });
  });

  test("stops when paused", () => {
    const paused = { ...freshArming(SESSION), paused: true };
    assert.deepEqual(decideNext(paused, SESSION, [task("a")]), { kind: "stop", reason: "paused" });
  });

  test("stops rather than re-pushing a task the agent never ticked off", () => {
    const arming = { ...freshArming(SESSION), used: 1, activeID: "a" };
    assert.deepEqual(decideNext(arming, SESSION, [task("a"), task("b")]), {
      kind: "stop",
      reason: "unfinished",
    });
  });

  test("advances once the active task leaves the pending list", () => {
    const arming = { ...freshArming(SESSION), used: 1, activeID: "a" };
    const decision = decideNext(arming, SESSION, [task("b")]);
    assert.equal(decision.kind, "run");
    if (decision.kind !== "run") return;
    assert.equal(decision.taskID, "b");
  });
});

describe("status text", () => {
  test("reports off", () => {
    assert.match(statusText(undefined), /off/);
  });

  test("counts down the remaining budget", () => {
    assert.match(statusText({ ...freshArming(SESSION), budget: 5, used: 2 }), /3 of 5/);
  });

  test("calls out a paused run", () => {
    assert.match(statusText({ ...freshArming(SESSION), paused: true }), /paused/);
  });

  test("calls out a spent budget", () => {
    assert.match(statusText({ ...freshArming(SESSION), budget: 2, used: 2 }), /budget/);
  });
});

describe("sidebar badge", () => {
  test("is absent when auto-run is off", () => {
    assert.equal(badgeText(undefined), undefined);
  });

  test("shows the counter and how to turn it off", () => {
    assert.equal(badgeText({ ...freshArming(SESSION), budget: 10, used: 0 }), "auto-run 0/10 · /queue-auto off");
  });

  test("marks a paused run", () => {
    assert.equal(badgeText({ ...freshArming(SESSION), paused: true }), "auto-run paused · /queue-auto");
  });
});
