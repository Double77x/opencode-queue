/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, untrack } from "solid-js";
import { type Arming, statusText, toggled } from "./core/autorun.ts";
import { listLine, pendingFirst, pickerLabel, position } from "./core/backlog.ts";
import { DONE, type Task, type TaskView } from "./core/task.ts";
import { readArming, writeArming } from "./stores/autorun.ts";
import * as queue from "./stores/queue.ts";
import { DEFAULT_VIEW, type ViewState } from "./stores/view.ts";
import { commandSet } from "./ui/commands.ts";
import { KeymapLayer, QueueSection } from "./ui/sidebar.tsx";
import { truncate } from "./utils/text.ts";

const TOAST_MAX_CHARS = 40;
const LIST_SEPARATOR = " · ";
const LIST_MAX_ENTRIES = 10;
const PANEL = "My Queue";
const BACKLOG_EMPTY = "Backlog is empty";
const COMPOSER_LIMITED =
  "OpenCode 2 does not yet expose an API for loading text into the native composer. The task stays pending and nothing was sent.\n\nTracked by anomalyco/opencode#51209.";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export default Plugin.define({
  id: "opencode-queue.tui",
  setup(context) {
    const worktree = context.location?.directory ?? context.data.location.default().directory;
    const [tasks, setTasks] = createSignal<Task[]>([]);
    const [arming, setArming] = createSignal<Arming | undefined>(undefined);

    // Accordion state is view state. context.storage commits its store only after
    // a cross-process lock and an fsynced write, so rendering from it makes a click
    // look dead. Render from a local signal and persist in the background.
    const [sections, setSections] = createSignal<ViewState>(DEFAULT_VIEW);
    const [storedView, storeView] = context.storage.store("sidebar", { initial: DEFAULT_VIEW });
    untrack(() => setSections({ ...storedView }));
    const keepSections = (next: ViewState) => {
      setSections(next);
      void storeView(() => Object.assign(next)).catch((error: unknown) => {
        console.error("[opencode-queue] sidebar state not persisted", error);
      });
    };

    const refreshArming = async () => setArming(await readArming(worktree));
    void refreshArming();
    const unsubscribe = queue.subscribe(
      worktree,
      (next) => {
        setTasks(next);
        void refreshArming();
      },
      (error) => console.error("[opencode-queue] queue refresh failed", error),
    );

    const toast = (variant: "success" | "info" | "error", message: string) =>
      context.ui.toast.show({ variant, message });

    async function safely(work: () => Promise<unknown>, onSuccess: () => void) {
      try {
        await work();
        onSuccess();
      } catch (error) {
        toast("error", `Queue: ${errorText(error)}`);
      }
    }

    async function currentSession(): Promise<string | undefined> {
      const route = context.ui.router.current();
      if (route.type === "session") return route.sessionID;
      await context.ui.dialog.alert({
        title: PANEL,
        message: "Tasks are per-session. Open a session first.",
      });
      return undefined;
    }

    async function currentTasks(): Promise<Task[] | undefined> {
      const sessionID = await currentSession();
      if (sessionID === undefined) return undefined;
      try {
        return await queue.load(worktree, sessionID);
      } catch (error) {
        toast("error", `Queue: ${errorText(error)}`);
        return undefined;
      }
    }

    async function pick(title: string, placeholder: string, views: TaskView[]) {
      if (views.length === 0) {
        await context.ui.dialog.alert({ title, message: BACKLOG_EMPTY });
        return undefined;
      }
      return context.ui.dialog.select<TaskView>({
        title,
        placeholder,
        options: views.map((view) => ({ title: pickerLabel(view), value: view })),
      });
    }

    const add = async () => {
      const sessionID = await currentSession();
      if (sessionID === undefined) return;
      const value = await context.ui.dialog.prompt({ title: "Add a task", placeholder: "What needs doing?" });
      if (value === undefined) return;
      const text = value.trim();
      if (text.length === 0) return;
      await safely(
        () => queue.add(worktree, sessionID, text),
        () => toast("success", `Added "${truncate(text, TOAST_MAX_CHARS)}"`),
      );
    };

    const run = async () => {
      const existing = await currentTasks();
      if (existing === undefined) return;
      const selected = await pick("Load a task", "Type to search", pendingFirst(position(existing)));
      if (selected === undefined) return;
      await context.ui.dialog.alert({ title: "Composer prefill unavailable", message: COMPOSER_LIMITED });
    };

    const setDone = async (reopen: boolean) => {
      const existing = await currentTasks();
      if (existing === undefined) return;
      const candidates = position(existing).filter((entry) => (entry.task.status === DONE) === reopen);
      if (candidates.length === 0) {
        await context.ui.dialog.alert({
          title: reopen ? "Reopen a task" : "Complete a task",
          message: reopen ? "No completed tasks to reopen." : "No pending tasks to complete.",
        });
        return;
      }
      const selected = await pick(
        reopen ? "Reopen a completed task" : "Mark a task complete",
        "Type to search",
        candidates,
      );
      if (selected === undefined) return;
      const apply = reopen ? queue.reopen : queue.complete;
      await safely(
        () => apply(worktree, selected.task.id, selected.task),
        () =>
          toast("success", `${reopen ? "Reopened" : "Completed"}: "${truncate(selected.task.text, TOAST_MAX_CHARS)}"`),
      );
    };

    const remove = async () => {
      const existing = await currentTasks();
      if (existing === undefined) return;
      const selected = await pick("Remove a task", "Type to search", position(existing));
      if (selected === undefined) return;
      await safely(
        () => queue.remove(worktree, selected.task.id, selected.task),
        () => toast("success", `Removed "${truncate(selected.task.text, TOAST_MAX_CHARS)}"`),
      );
    };

    const edit = async () => {
      const existing = await currentTasks();
      if (existing === undefined) return;
      const selected = await pick("Edit a task", "Type to search, Enter to edit", pendingFirst(position(existing)));
      if (selected === undefined) return;
      const value = await context.ui.dialog.prompt({ title: "Edit task", value: selected.task.text });
      if (value === undefined) return;
      const text = value.trim();
      if (text.length === 0) return;
      await safely(
        () => queue.edit(worktree, selected.task.id, text, selected.task),
        () => toast("success", `Updated: "${truncate(text, TOAST_MAX_CHARS)}"`),
      );
    };

    const list = async () => {
      const existing = await currentTasks();
      if (existing === undefined) return;
      if (existing.length === 0) {
        toast("info", BACKLOG_EMPTY);
        return;
      }
      const head = existing.slice(0, LIST_MAX_ENTRIES).map((task, index) => listLine({ position: index + 1, task }));
      const rest = existing.length - LIST_MAX_ENTRIES;
      const message =
        rest > 0 ? `${head.join(LIST_SEPARATOR)}${LIST_SEPARATOR}…and ${rest} more` : head.join(LIST_SEPARATOR);
      toast("info", message);
    };

    const clear = async () => {
      const sessionID = await currentSession();
      if (sessionID === undefined) return;
      const existing = await currentTasks();
      if (existing === undefined) return;
      if (existing.length === 0) {
        await context.ui.dialog.alert({ title: "Clear queue", message: BACKLOG_EMPTY });
        return;
      }
      const plural = existing.length === 1 ? "task" : "tasks";
      const confirmed = await context.ui.dialog.confirm({
        title: "Clear queue",
        message: `Delete ${existing.length} ${plural} from this session? Anything added while this is open is kept.`,
        label: { confirm: "Clear", cancel: "Cancel" },
      });
      if (confirmed !== true) return;
      await safely(
        () => queue.clearSession(worktree, sessionID, new Set(existing.map((task) => task.id))),
        () => toast("success", `Cleared ${existing.length} ${plural}`),
      );
    };

    const toggleAutoRun = async () => {
      const sessionID = await currentSession();
      if (sessionID === undefined) return;
      const next = toggled(await readArming(worktree), sessionID);
      await writeArming(worktree, next);
      setArming(next);
      toast("success", next === undefined ? "Auto-run off" : `Auto-run on: up to ${next.budget} tasks`);
    };

    const showAutoRun = async () => {
      const sessionID = await currentSession();
      if (sessionID === undefined) return;
      const current = await readArming(worktree);
      await context.ui.dialog.alert({
        title: "Queue auto-run",
        message: statusText(current?.sessionID === sessionID ? current : undefined),
      });
    };

    const commands = commandSet({
      add,
      run,
      complete: () => setDone(false),
      reopen: () => setDone(true),
      remove,
      edit,
      list,
      clear,
      toggleAutoRun,
      showAutoRun,
    });

    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <QueueSection
          sessionID={sessionID}
          tasks={tasks()}
          arming={arming()}
          view={sections()}
          onToggleQueue={() => keepSections({ ...sections(), queueExpanded: !sections().queueExpanded })}
          onToggleStashed={() => keepSections({ ...sections(), stashedExpanded: !sections().stashedExpanded })}
        />
      ),
    });

    const unregisterKeys = context.ui.slot({
      append: "app",
      render: () => <KeymapLayer commands={commands} />,
    });

    return () => {
      unregisterSidebar();
      unregisterKeys();
      unsubscribe();
    };
  },
});
