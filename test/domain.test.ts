import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { listLine, marker, nextTask, pendingFirst, pickerLabel, position } from "../src/core/backlog.ts";
import { DONE, PENDING, toTask, type Task } from "../src/core/task.ts";
import { truncate } from "../src/utils/text.ts";
import { parseJson, readCount, readString } from "../src/utils/json.ts";

function task(id: string, status: typeof PENDING | typeof DONE = PENDING, text = `t-${id}`): Task {
  return { id, sessionID: "ses", text, createdAt: "", status };
}

describe("truncate", () => {
  test("leaves short text alone", () => {
    assert.equal(truncate("hello", 10), "hello");
  });

  test("keeps the result within the budget", () => {
    assert.equal(Array.from(truncate("hello world", 8)).length, 8);
  });

  test("never splits a surrogate pair", () => {
    const emoji = "👍";
    assert.equal(truncate(`${emoji}${emoji}${emoji}`, 3), `${emoji}${emoji}${emoji}`);
    assert.equal(truncate(`${emoji}${emoji}${emoji}`, 2), `${emoji}…`);
  });

  test("handles a zero budget", () => {
    assert.equal(truncate("hello", 0), "");
  });
});

describe("json helpers", () => {
  test("parseJson returns undefined for junk", () => {
    assert.equal(parseJson("{"), undefined);
    assert.deepEqual(parseJson("[1]"), [1]);
  });

  test("readString falls back", () => {
    assert.equal(readString({ a: "x" }, "a"), "x");
    assert.equal(readString({ a: 1 }, "a", "fallback"), "fallback");
  });

  test("readCount rejects junk and clamps", () => {
    assert.equal(readCount({ n: 5 }, "n", 10), 5);
    assert.equal(readCount({ n: 1.5 }, "n", 10), 0);
    assert.equal(readCount({ n: -2 }, "n", 10), 0);
    assert.equal(readCount({ n: 99 }, "n", 10), 10);
  });
});

describe("toTask", () => {
  test("accepts a well-formed record", () => {
    const value = { id: "a", sessionID: "ses", text: "hello", createdAt: "now", status: DONE };
    assert.deepEqual(toTask(value), value);
  });

  test("coerces an unknown status to pending rather than dropping it", () => {
    const result = toTask({ id: "a", sessionID: "ses", text: "x", status: "weird" });
    assert.equal(result?.status, PENDING);
  });

  test("tolerates a missing createdAt", () => {
    assert.equal(toTask({ id: "a", sessionID: "ses", text: "x" })?.createdAt, "");
  });

  for (const [label, value] of [
    ["null", null],
    ["a string", "nope"],
    ["an array", []],
    ["a record with no id", { sessionID: "s", text: "t" }],
    ["a record with no session", { id: "a", text: "t" }],
    ["a record with no text", { id: "a", sessionID: "s" }],
  ] as const) {
    test(`rejects ${label}`, () => {
      assert.equal(toTask(value), undefined);
    });
  }
});

describe("ordering and labels", () => {
  test("position numbers follow file order", () => {
    assert.deepEqual(
      position([task("a"), task("b")]).map((entry) => entry.position),
      [1, 2],
    );
  });

  test("pendingFirst is stable and puts pending first", () => {
    const ordered = pendingFirst(position([task("a", DONE), task("b"), task("c", DONE), task("d")]));
    assert.deepEqual(
      ordered.map((entry) => entry.task.id),
      ["b", "d", "a", "c"],
    );
  });

  test("marker distinguishes done from pending", () => {
    assert.notEqual(marker(DONE), marker(PENDING));
  });

  test("pickerLabel marks completed work", () => {
    assert.match(pickerLabel({ position: 2, task: task("a", DONE) }), /^2\. ✓/);
    assert.doesNotMatch(pickerLabel({ position: 2, task: task("a") }), /✓/);
  });

  test("listLine truncates long text", () => {
    const line = listLine({ position: 1, task: task("a", PENDING, "x".repeat(200)) });
    assert.ok(line.length < 100, `expected a truncated line, got ${line.length} chars`);
  });

  test("nextTask skips completed work", () => {
    assert.equal(nextTask([task("a", DONE), task("b")])?.id, "b");
    assert.equal(nextTask([task("a", DONE)]), undefined);
  });
});
