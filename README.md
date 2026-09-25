# opencode-queue

A task queue for [OpenCode 2](https://opencode.ai) that you own, and the agent can work through on its own.

## The problem

You are watching an agent refactor authentication middleware when you remember three follow-ups. You send the first one
mid-run, and something predictable happens:

1. The agent stops what it was doing.
2. It does your second thing.
3. It comes back and asks whether it should continue with the original task.

Now you have two half-finished threads and an agent that has lost the thread on both. The first task is not
abandoned — it is _interrupted_, and interruptions are expensive. The model re-reads context, re-decides, and often
re-does work it had already completed.

This is not a prompting problem. It is a queueing problem. There is nowhere to put a follow-up that says "after this,
not now."

OpenCode V1 had a `todowrite` tool, but that list belonged to the **model**: it was the agent's own scratchpad for the
task in front of it. It cannot help, because the problem is a message the agent has not received yet. V2 removed the
tool entirely ([#42421](https://github.com/anomalyco/opencode/issues/42421), described upstream as
[intentional](https://github.com/anomalyco/opencode/issues/42421#issuecomment-1)).

`opencode-queue` is the other thing: a list that belongs to **you**, that survives turns, and that the agent drains in
order — one task at a time, optionally with nobody watching.

## Install

```sh
bunx opencode@latest plugin add opencode-queue
```

Restart OpenCode afterwards.

Requires OpenCode 2.0 or newer.

## The loop

```sh
/queue-add something you just thought of     # capture it, keep working
/queue-list                                    # what is queued
/queue-run                                     # take the next one
/queue-done                                    # tick it off
```

That is the whole manual loop. Nothing is ever submitted for you, and the agent cannot see your queue unless you arm
auto-run.

### Auto-run

`/queue-auto` lets the agent work through the queue unattended. When the session goes idle, the plugin hands it the
next task; the agent calls `queue_done` when it finishes, and the next one follows.

```sh
/queue-auto          # arm for this session
/queue-auto-status   # what is armed, how much is left
/queue-auto          # again, to turn it off
```

This is the only mode in which the plugin submits a prompt, and it is fenced:

- **Per session.** Other sessions, worktrees and locations are never touched.
- **Budgeted.** Ten tasks by default. Running out stops the run; `/queue-auto` rearms it.
- **No loops.** If a task is handed over and never ticked off, the run pauses instead of resubmitting it.
- **Fails closed.** A corrupt or hand-edited `.opencode/autorun.json` reads as _off_, never as consent. Deleting the
  file is a valid way to disarm it.

While armed, the agent gets two tools — `queue_list` (read-only) and `queue_done` — and nothing else. Both refuse when
auto-run is off, so the default guarantee that the agent cannot read your queue still holds.

It also costs real model turns with nobody watching. That is the point, and also the risk.

## Commands

| Command              | What it does                                                  |
| -------------------- | ------------------------------------------------------------- |
| `/queue-add`         | Capture a task for this session.                              |
| `/queue-list`        | Print the queue.                                              |
| `/queue-run`         | Pick a task. Does not submit it; see the limitation below.    |
| `/queue-done`        | Mark a pending task complete.                                 |
| `/queue-reopen`      | Return a completed task to pending.                           |
| `/queue-edit`        | Edit a task. Editing a completed task makes it pending again. |
| `/queue-remove`      | Delete a task.                                                |
| `/queue-clear`       | Confirm, then clear this session's queue.                     |
| `/queue-auto`        | Toggle unattended auto-run.                                   |
| `/queue-auto-status` | Report auto-run state.                                        |

Every command is also in the command palette.

## Sidebar

Two collapsible sections:

- **My Queue** — this session's tasks, newest last, completed ones dimmed and struck through, with a live count. While
  collapsed, the header carries a badge such as `auto-run 0/10 · /queue-auto off`, matching how OpenCode's own MCP
  section summarises itself.
- **Stashed requests** — prompts you already sent that the agent has not picked up yet. Auto-run drains your _queue_, not
  the OpenCode inbox, so this is the only signal that a message of yours is stuck.

## Storage

Everything lives in `.opencode/` in the project, as readable JSON:

| File           | Holds                                                           |
| -------------- | --------------------------------------------------------------- |
| `queue.json`   | Your tasks. Add it to `.gitignore`; task text can be sensitive. |
| `autorun.json` | Auto-run arming. No task text. Delete to disarm.                |

Both are written atomically with an fsynced replace, under a cross-process file lock, so several OpenCode windows can
work in the same project without losing each other's writes. A file that cannot be parsed is moved aside as
`queue.json.corrupt-<timestamp>` rather than silently overwritten.

## Limitations

- **`/queue-run` cannot prefill the composer.** OpenCode 2 has no public API for putting text into the native composer, so
  the command picks a task and stops. Tracked at
  [anomalyco/opencode#51209](https://github.com/anomalyco/opencode/issues/51209).
- **`session.idle` cannot tell "finished" from "waiting for you".** A task the agent declines pauses the run rather than
  being retried.
- **Auto-run is one session at a time.** Arming a second session replaces the first.

## Development

```sh
bun install
bun run check
```

`check` runs formatting, lint, strict typecheck and the test suite. Tests use real files and real child processes; the
cross-process locking test spawns four concurrent writers and asserts none are lost.

Start OpenCode against this checkout with `bun run dev`.

## Licence

MIT.
