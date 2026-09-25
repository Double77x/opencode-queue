import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { type Arming, decideNext, describeStop, isArmedFor } from "./core/autorun.ts";
import { PENDING } from "./core/task.ts";
import { watchFile } from "./libs/watcher.ts";
import { readArming, writeArming } from "./stores/autorun.ts";
import { clearSession, complete, load, loadAll } from "./stores/queue.ts";

const DONE_TOOL = "queue_done";
const LIST_TOOL = "queue_list";

/**
 * A finished turn. OpenCode has no `session.idle` event: the real names are
 * `session.execution.succeeded`, `.failed` and `.interrupted`. Only a normal
 * finish counts, because a failed turn leaves the active task unfinished and
 * the no-re-push guard must stop the run rather than retry it.
 */
export const TURN_FINISHED = "session.execution.succeeded";

const ARMING_FILE = ".opencode/autorun.json";

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const;

const GUIDANCE = [
  "The user keeps a personal task queue for this session, managed by the opencode-queue plugin.",
  "The message you have just been given is one queue task, handed to you automatically.",
  "Work on that task and nothing else. Do not start a task that was not handed to you.",
  `Call ${LIST_TOOL} if you need to see what is still queued or how much is left.`,
  `Call ${DONE_TOOL} once the task is genuinely finished. If you are blocked, do not call it; stop and explain.`,
].join(" ");

function promptFor(text: string): string {
  return ["Next task from your queue:", "", text, "", `Work on this now. Call ${DONE_TOOL} when it is finished.`].join(
    "\n",
  );
}

type ToolOutput = { content: string };

export default Plugin.define({
  id: "opencode-queue.server",
  setup(ctx) {
    const worktree = ctx.location.directory;
    const controller = new AbortController();
    const pushing = new Set<string>();

    const pause = async (arming: Arming) => {
      if (arming.paused) return;
      await writeArming(worktree, { ...arming, paused: true }).catch((error: unknown) => {
        console.error("[opencode-queue] could not pause auto-run", error);
      });
    };

    const tickOff = async (sessionID: string): Promise<string> => {
      const arming = await readArming(worktree);
      if (!isArmedFor(arming, sessionID)) return "Auto-run is not enabled for this session.";
      if (arming.activeID.length === 0) return "No queue task is currently active.";
      const active = (await loadAll(worktree)).find((task) => task.id === arming.activeID);
      if (active === undefined) {
        await writeArming(worktree, { ...arming, activeID: "" });
        return "The active task no longer exists. Cleared it.";
      }
      await complete(worktree, active.id, active);
      await writeArming(worktree, { ...arming, activeID: "" });
      return `Marked the task complete: ${active.text}`;
    };

    const describeQueue = async (sessionID: string): Promise<string> => {
      const arming = await readArming(worktree);
      if (!isArmedFor(arming, sessionID)) return "Auto-run is not enabled for this session.";
      const tasks = await load(worktree, sessionID);
      if (tasks.length === 0) return "The queue is empty.";
      const pending = tasks.filter((task) => task.status === PENDING).length;
      const lines = tasks.map((task, index) => {
        const mark = task.status !== PENDING ? "[x]" : arming?.activeID === task.id ? "[>]" : "[ ]";
        return `${mark} ${index + 1}. ${task.text}`;
      });
      return [`Queue: ${pending} pending of ${tasks.length}.`, ...lines].join("\n");
    };

    const onTurnFinished = async (sessionID: string) => {
      if (pushing.has(sessionID)) return;
      pushing.add(sessionID);
      try {
        const arming = await readArming(worktree);
        if (!isArmedFor(arming, sessionID)) return;
        const pending = (await load(worktree, sessionID)).filter((task) => task.status === PENDING);
        const decision = decideNext(arming, sessionID, pending);
        if (decision.kind === "inactive") return;
        if (decision.kind === "stop") {
          console.log(`[opencode-queue] auto-run stopped: ${describeStop(decision.reason)}`);
          if (decision.reason === "unfinished") await pause(arming);
          return;
        }
        await writeArming(worktree, decision.next);
        await ctx.session.prompt({
          sessionID,
          text: promptFor(decision.taskText),
          delivery: "queue",
        });
      } catch (error) {
        console.error("[opencode-queue] auto-run failed", error);
      } finally {
        pushing.delete(sessionID);
      }
    };

    /**
     * Arming a run has to start it. The only other trigger is a finished turn,
     * so a user who arms a queue while the session sits idle would otherwise
     * wait forever for the agent to spontaneously finish something. Only a
     * change of armed session counts, so the plugin's own bookkeeping writes
     * cannot be mistaken for a new arming and pause the run they just started.
     * The seed matters for the same reason: without it the first push would
     * look like the first arming.
     */
    let armedSession: string | undefined;
    const seeded = readArming(worktree).then(
      (arming) => {
        armedSession = arming?.sessionID;
      },
      () => undefined,
    );
    const reconcile = async () => {
      await seeded;
      try {
        const arming = await readArming(worktree);
        const next = arming?.sessionID;
        if (next === armedSession) return;
        armedSession = next;
        if (next === undefined) return;
        await onTurnFinished(next);
      } catch (error) {
        console.error("[opencode-queue] could not reconcile auto-run", error);
      }
    };
    const stopWatching = watchFile(join(worktree, ARMING_FILE), () => void reconcile());

    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.location && event.location.directory !== worktree) continue;
          if (event.type === "session.deleted") {
            await clearSession(worktree, event.data.sessionID).catch((error: unknown) => {
              console.error("[opencode-queue] could not purge a deleted session", error);
            });
            const arming = await readArming(worktree);
            if (arming?.sessionID === event.data.sessionID) await writeArming(worktree, undefined);
            continue;
          }
          if (event.type === TURN_FINISHED) await onTurnFinished(event.data.sessionID);
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[opencode-queue] event stream failed", error);
      }
    })();

    const tool = ctx.tool.transform((editor) => {
      editor.add({
        name: DONE_TOOL,
        description:
          "Mark the queue task you were given as complete. Only call it once the work is genuinely finished, and never if you are blocked.",
        input: NO_INPUT,
        execute: async (_input, toolCtx): Promise<ToolOutput> => ({ content: await tickOff(toolCtx.sessionID) }),
      });
      editor.add({
        name: LIST_TOOL,
        description: "List this session's queue tasks and show which one is active. Read-only.",
        input: NO_INPUT,
        execute: async (_input, toolCtx): Promise<ToolOutput> => ({ content: await describeQueue(toolCtx.sessionID) }),
      });
    });

    const context = ctx.session.hook("context", async (sessionCtx) => {
      const arming = await readArming(worktree);
      if (!isArmedFor(arming, sessionCtx.sessionID) || arming.paused) return;
      sessionCtx.system.push({ type: "text", text: GUIDANCE });
    });

    const reload = ctx.tool.reload().catch((error: unknown) => {
      console.error("[opencode-queue] tool reload failed", error);
    });

    return async () => {
      controller.abort();
      stopWatching();
      await events;
      await reload;
      for (const registration of await Promise.all([tool, context])) await registration.dispose();
    };
  },
});
