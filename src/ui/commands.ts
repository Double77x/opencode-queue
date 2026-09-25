import type { KeymapCommand } from "@opencode/plugin/tui/context";

export type Handlers = {
  add: () => Promise<void>;
  run: () => Promise<void>;
  complete: () => Promise<void>;
  reopen: () => Promise<void>;
  remove: () => Promise<void>;
  edit: () => Promise<void>;
  list: () => Promise<void>;
  clear: () => Promise<void>;
  toggleAutoRun: () => Promise<void>;
  showAutoRun: () => Promise<void>;
};

function entry(
  id: string,
  title: string,
  slash: string,
  run: () => Promise<void>,
  description?: string,
): KeymapCommand {
  return description === undefined
    ? { id, title, group: "Queue", palette: true, slash: { name: slash }, run }
    : { id, title, description, group: "Queue", palette: true, slash: { name: slash }, run };
}

export function commandSet(handlers: Handlers): readonly KeymapCommand[] {
  return [
    entry("opencode-queue.add", "Queue: add task", "queue-add", handlers.add),
    entry(
      "opencode-queue.run",
      "Queue: load task",
      "queue-run",
      handlers.run,
      "OpenCode 2 cannot yet prefill the native composer, so the task stays pending",
    ),
    entry("opencode-queue.done", "Queue: mark task complete", "queue-done", handlers.complete),
    entry("opencode-queue.reopen", "Queue: reopen task", "queue-reopen", handlers.reopen),
    entry("opencode-queue.remove", "Queue: remove task", "queue-remove", handlers.remove),
    entry("opencode-queue.edit", "Queue: edit task", "queue-edit", handlers.edit),
    entry("opencode-queue.list", "Queue: list tasks", "queue-list", handlers.list),
    entry("opencode-queue.clear", "Queue: clear tasks", "queue-clear", handlers.clear),
    entry(
      "opencode-queue.auto",
      "Queue: toggle auto-run",
      "queue-auto",
      handlers.toggleAutoRun,
      "Let the agent work through this session's queue unattended",
    ),
    entry("opencode-queue.auto-status", "Queue: show auto-run status", "queue-auto-status", handlers.showAutoRun),
  ];
}
