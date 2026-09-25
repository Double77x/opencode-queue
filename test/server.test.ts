import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { freshArming, type Arming } from "../src/core/autorun.ts";
import { add, complete, load } from "../src/stores/queue.ts";
import { readArming, writeArming } from "../src/stores/autorun.ts";
import plugin from "../src/server.ts";

const A = "ses_aaa";
const B = "ses_bbb";
const OTHER = "C:\\elsewhere";

type Tool = { name: string; execute: (input: unknown, ctx: { sessionID: string }) => Promise<{ content: string }> };
type Registered = { tools: string[]; byName: Map<string, Tool>; prompts: unknown[]; hookName?: string };

const noop = { dispose: () => Promise.resolve(undefined) };

let worktree: string;
const scratch: string[] = [];

beforeEach(async () => {
  worktree = await mkdtemp(path.join(tmpdir(), "queue-server-"));
  scratch.push(worktree);
});

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function drain(...events: unknown[]) {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    settled,
    async *subscribe() {
      try {
        for (const event of events) yield event;
      } finally {
        finish();
      }
    },
  };
}

function contextFor(subscribe: () => AsyncIterable<unknown>) {
  const registered: Registered = { tools: [], byName: new Map(), prompts: [] };
  const context = {
    location: { directory: worktree },
    event: { subscribe },
    tool: {
      transform: (callback: (editor: { add: (tool: Tool) => void }) => void) => {
        callback({
          add: (tool) => {
            registered.tools.push(tool.name);
            registered.byName.set(tool.name, tool);
          },
        });
        return Promise.resolve(noop);
      },
      reload: () => Promise.resolve(undefined),
    },
    session: {
      hook: (name: string) => {
        registered.hookName = name;
        return Promise.resolve(noop);
      },
      prompt: (input: unknown) => {
        registered.prompts.push(input);
        return Promise.resolve(undefined);
      },
    },
  };
  return { context, registered };
}

async function run(...events: unknown[]): Promise<Registered> {
  const { settled, subscribe } = drain(...events);
  const { context, registered } = contextFor(subscribe);
  const cleanup = await plugin.setup(context as never);
  await settled;
  if (typeof cleanup === "function") await cleanup();
  return registered;
}

async function callTool(name: string, sessionID: string): Promise<string> {
  const registered = await run();
  const tool = registered.byName.get(name);
  assert.ok(tool, `${name} was not registered`);
  return (await tool.execute(undefined, { sessionID })).content;
}

function idle(sessionID: string, directory: string | undefined = worktree) {
  return {
    id: `e_${sessionID}`,
    created: Date.now(),
    type: "session.idle",
    location: directory === undefined ? undefined : { directory },
    data: { sessionID },
  };
}

function deleted(sessionID: string, directory: string | undefined = worktree) {
  return {
    id: `e_${sessionID}`,
    created: Date.now(),
    type: "session.deleted",
    location: directory === undefined ? undefined : { directory },
    data: { sessionID },
  };
}

async function armFor(sessionID: string, overrides: Partial<Arming> = {}): Promise<void> {
  await writeArming(worktree, { ...freshArming(sessionID), ...overrides });
}

describe("server plugin registration", () => {
  test("registers both agent tools and the session context hook", async () => {
    const registered = await run();
    assert.deepEqual(registered.tools, ["queue_done", "queue_list"]);
    assert.equal(registered.hookName, "context");
  });
});

describe("auto-run stays silent until armed", () => {
  test("does not prompt when there is no arming", async () => {
    await add(worktree, A, "a1");
    assert.deepEqual((await run(idle(A))).prompts, []);
  });

  test("does not prompt a session that did not opt in", async () => {
    await add(worktree, B, "b1");
    await armFor(A);
    assert.deepEqual((await run(idle(B))).prompts, []);
  });

  test("does not prompt for an idle event from another location", async () => {
    await add(worktree, A, "a1");
    await armFor(A);
    assert.deepEqual((await run(idle(A, OTHER))).prompts, []);
  });

  test("does not prompt when the queue is empty", async () => {
    await armFor(A);
    assert.deepEqual((await run(idle(A))).prompts, []);
  });
});

describe("auto-run drives the queue in order", () => {
  test("prompts the oldest pending task once", async () => {
    await add(worktree, A, "first");
    await add(worktree, A, "second");
    await armFor(A);
    const registered = await run(idle(A));
    assert.equal(registered.prompts.length, 1);
    const prompt = registered.prompts[0] as { sessionID: string; text: string };
    assert.equal(prompt.sessionID, A);
    assert.match(prompt.text, /first/);
    assert.doesNotMatch(prompt.text, /second/);
  });

  test("records the pushed task and spends one unit of budget", async () => {
    await add(worktree, A, "first");
    await armFor(A);
    await run(idle(A));
    const arming = await readArming(worktree);
    assert.equal(arming?.used, 1);
    assert.equal(arming?.activeID.length, 12);
  });

  test("pauses instead of looping when a task is never completed", async () => {
    const first = await add(worktree, A, "first");
    await add(worktree, A, "second");
    await armFor(A, { used: 1, activeID: first.id });
    assert.deepEqual((await run(idle(A))).prompts, []);
    assert.equal((await readArming(worktree))?.paused, true);
  });

  test("prompts nothing once the budget is spent", async () => {
    await add(worktree, A, "first");
    await armFor(A, { used: 10 });
    assert.deepEqual((await run(idle(A))).prompts, []);
  });
});

describe("session deletion", () => {
  test("purges that session's tasks", async () => {
    await add(worktree, A, "a1");
    await add(worktree, B, "b1");
    await run(deleted(A));
    assert.deepEqual(await load(worktree, A), []);
    assert.equal((await load(worktree, B)).length, 1);
  });

  test("ignores a deletion from another location", async () => {
    await add(worktree, A, "a1");
    await run(deleted(A, OTHER));
    assert.equal((await load(worktree, A)).length, 1);
  });

  test("clears the arming for the deleted session", async () => {
    await armFor(A);
    await run(deleted(A));
    assert.equal(await readArming(worktree), undefined);
  });
});

describe("agent tools", () => {
  test("queue_list refuses to read the queue when auto-run is off", async () => {
    await add(worktree, A, "confidential");
    assert.match(await callTool("queue_list", A), /not enabled/);
    assert.doesNotMatch(await callTool("queue_list", A), /confidential/);
  });

  test("queue_done refuses to act when auto-run is off", async () => {
    const only = await add(worktree, A, "confidential");
    assert.match(await callTool("queue_done", A), /not enabled/);
    assert.equal((await load(worktree, A))[0]?.status, "pending");
    assert.equal(only.status, "pending");
  });

  test("queue_list shows pending, active and completed work", async () => {
    const first = await add(worktree, A, "first");
    await add(worktree, A, "second");
    const third = await add(worktree, A, "third");
    await complete(worktree, third.id, third);
    await armFor(A, { used: 1, activeID: first.id });
    const content = await callTool("queue_list", A);
    assert.match(content, /2 pending of 3/);
    assert.match(content, /\[>\] 1\. first/);
    assert.match(content, /\[x\] 3\. third/);
  });

  test("queue_done completes the active task and clears it", async () => {
    const first = await add(worktree, A, "first");
    await add(worktree, A, "second");
    await armFor(A, { used: 1, activeID: first.id });
    assert.match(await callTool("queue_done", A), /Marked the task complete: first/);
    assert.deepEqual(
      (await load(worktree, A)).map((task) => `${task.text}:${task.status}`),
      ["first:done", "second:pending"],
    );
    assert.equal((await readArming(worktree))?.activeID, "");
  });

  test("queue_done reports when nothing is active", async () => {
    await armFor(A);
    assert.match(await callTool("queue_done", A), /No queue task is currently active/);
  });

  test("queue_list does not leak another session's queue", async () => {
    await add(worktree, B, "other session work");
    await armFor(A);
    assert.doesNotMatch(await callTool("queue_list", B), /other session work/);
  });
});
