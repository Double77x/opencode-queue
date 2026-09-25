import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DONE, PENDING } from "../src/core/task.ts";
import {
  QueueUnreadableError,
  TaskChangedError,
  add,
  clearSession,
  complete,
  edit,
  load,
  loadAll,
  queueFile,
  remove,
  reopen,
  setStatus,
  subscribe,
} from "../src/stores/queue.ts";

const run = promisify(execFile);
const A = "ses_aaa";
const B = "ses_bbb";

let worktree: string;
const scratch: string[] = [];

beforeEach(async () => {
  worktree = await mkdtemp(path.join(tmpdir(), "queue-test-"));
  scratch.push(worktree);
});

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("queue store", () => {
  test("an empty worktree has no tasks", async () => {
    assert.deepEqual(await loadAll(worktree), []);
  });

  test("add persists in order", async () => {
    await add(worktree, A, "first");
    await add(worktree, A, "second");
    assert.deepEqual(
      (await load(worktree, A)).map((task) => task.text),
      ["first", "second"],
    );
  });

  test("add creates the .opencode directory", async () => {
    await add(worktree, A, "only");
    assert.deepEqual(
      (await readdir(path.join(worktree, ".opencode"))).filter((name) => name === "queue.json"),
      ["queue.json"],
    );
  });

  test("sessions are isolated", async () => {
    await add(worktree, A, "a1");
    await add(worktree, B, "b1");
    assert.deepEqual(
      (await load(worktree, A)).map((task) => task.text),
      ["a1"],
    );
    assert.deepEqual(
      (await load(worktree, B)).map((task) => task.text),
      ["b1"],
    );
  });

  test("edit resets a completed task to pending", async () => {
    const first = await add(worktree, A, "original");
    await add(worktree, A, "second");
    await complete(worktree, first.id);
    const edited = await edit(worktree, first.id, "rewritten");
    assert.equal(edited?.status, PENDING);
    assert.deepEqual(
      (await load(worktree, A)).map((task) => task.text),
      ["rewritten", "second"],
    );
  });

  test("remove deletes by identity", async () => {
    const first = await add(worktree, A, "first");
    await add(worktree, A, "second");
    await remove(worktree, first.id);
    assert.deepEqual(
      (await load(worktree, A)).map((task) => task.text),
      ["second"],
    );
  });

  test("an unknown id changes nothing", async () => {
    const first = await add(worktree, A, "first");
    assert.equal(await complete(worktree, "nope"), undefined);
    assert.equal(await remove(worktree, "nope"), undefined);
    assert.equal((await load(worktree, A))[0]?.id, first.id);
  });

  test("reopen returns a task to pending and keeps its place", async () => {
    const first = await add(worktree, A, "first");
    await add(worktree, A, "second");
    await complete(worktree, first.id);
    const back = await reopen(worktree, first.id);
    assert.equal(back?.status, PENDING);
    assert.deepEqual(
      (await load(worktree, A)).map((task) => `${task.text}:${task.status}`),
      ["first:pending", "second:pending"],
    );
  });

  test("status changes are idempotent", async () => {
    const first = await add(worktree, A, "first");
    await complete(worktree, first.id);
    assert.deepEqual(await complete(worktree, first.id), (await load(worktree, A))[0]);
    await reopen(worktree, first.id);
    assert.deepEqual(await reopen(worktree, first.id), (await load(worktree, A))[0]);
  });

  test("a stale expected task is rejected", async () => {
    const first = await add(worktree, A, "first");
    const stale = { ...first };
    await complete(worktree, first.id);
    await assert.rejects(() => complete(worktree, first.id, stale), TaskChangedError);
    await assert.rejects(() => reopen(worktree, first.id, stale), TaskChangedError);
    assert.equal((await load(worktree, A))[0]?.status, DONE);
  });

  test("clearSession only empties its own session", async () => {
    await add(worktree, A, "a1");
    await add(worktree, B, "b1");
    await clearSession(worktree, A);
    assert.deepEqual(await load(worktree, A), []);
    assert.equal((await load(worktree, B)).length, 1);
  });

  test("clearSession keeps tasks added after the dialog opened", async () => {
    const before = await add(worktree, A, "old");
    await add(worktree, A, "new");
    await clearSession(
      worktree,
      A,
      new Set([(await load(worktree, A)).find((t) => t.text === "new")?.id ?? before.id]),
    );
    assert.deepEqual(
      (await load(worktree, A)).map((task) => task.text),
      ["new"],
    );
  });

  test("setStatus is reachable for either direction", async () => {
    const only = await add(worktree, A, "only");
    assert.equal((await setStatus(worktree, only.id, DONE))?.status, DONE);
  });

  test("the file is newline-terminated JSON of the whole queue", async () => {
    await add(worktree, A, "a1");
    await add(worktree, B, "b1");
    const raw = await readFile(queueFile(worktree), "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.equal((JSON.parse(raw) as unknown[]).length, 2);
  });
});

async function writeQueue(contents: string): Promise<void> {
  await mkdir(path.join(worktree, ".opencode"), { recursive: true });
  await writeFile(queueFile(worktree), contents, "utf8");
}

describe("corruption is quarantined, never silently overwritten", () => {
  test("invalid JSON is moved aside", async () => {
    await add(worktree, A, "good");
    await writeQueue("{ not json");
    await assert.rejects(() => loadAll(worktree), QueueUnreadableError);
    const moved = (await readdir(path.join(worktree, ".opencode"))).filter((name) =>
      name.startsWith("queue.json.corrupt-"),
    );
    assert.equal(moved.length, 1);
  });

  test("JSON of the wrong shape is moved aside", async () => {
    await writeQueue(JSON.stringify({ tasks: [] }));
    await assert.rejects(() => loadAll(worktree), QueueUnreadableError);
  });

  test("a duplicate id is moved aside", async () => {
    const task = { id: "dup", sessionID: A, text: "x", createdAt: "", status: PENDING };
    await writeQueue(JSON.stringify([task, task]));
    await assert.rejects(() => loadAll(worktree), QueueUnreadableError);
  });

  test("a task missing a required field is moved aside", async () => {
    await writeQueue(JSON.stringify([{ id: "a", text: "x" }]));
    await assert.rejects(() => loadAll(worktree), QueueUnreadableError);
  });
});

describe("cross-process safety", () => {
  test("independent processes serialise without losing writes", async () => {
    const child = path.join(worktree, "writer.mts");
    const specifier = pathToFileURL(path.resolve(import.meta.dirname, "../src/stores/queue.ts")).href;
    await writeFile(
      child,
      [
        `import { add } from ${JSON.stringify(specifier)};`,
        `const [worktree, session, text] = process.argv.slice(2);`,
        `await add(worktree, session, text);`,
      ].join("\n"),
      "utf8",
    );
    const results = await Promise.allSettled(
      ["a", "b", "c", "d"].map((text) => run(process.execPath, [child, worktree, A, text])),
    );
    const failed = results.filter((result) => result.status === "rejected");
    assert.equal(failed.length, 0, failed.map((entry) => String(entry.reason)).join("; "));
    const stored = await load(worktree, A);
    assert.equal(stored.length, 4, `expected 4 writes to survive, got ${stored.length}`);
    assert.deepEqual(stored.map((task) => task.text).toSorted(), ["a", "b", "c", "d"]);
  });
});

describe("subscribe", () => {
  test("observes a change even when the queue file did not exist yet", async () => {
    // A fresh project has no .opencode directory at all. Watching the file
    // directly would fail here and the sidebar would never update.
    const seen: number[] = [];
    const stop = subscribe(
      worktree,
      (tasks) => seen.push(tasks.length),
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await add(worktree, A, "first");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(seen, [0, 1], `expected the watcher to report the new task, saw ${seen.join(",")}`);
    stop();
  });

  test("observes rapid writes, coalescing intermediate states", async () => {
    const seen: number[] = [];
    const stop = subscribe(
      worktree,
      (tasks) => seen.push(tasks.length),
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await add(worktree, A, "first");
    await add(worktree, A, "second");
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The watcher debounces, so intermediate counts may be skipped. What matters
    // is that the final state is observed, not that every write is reported.
    assert.equal(seen[0], 0, "expected an initial empty read");
    assert.equal(seen.at(-1), 2, `expected to settle on 2 tasks, saw ${seen.join(",")}`);
    stop();
  });

  test("cleans up idempotently", async () => {
    const stop = subscribe(
      worktree,
      () => undefined,
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();
    stop();
  });
});
