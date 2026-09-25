# AGENTS.md

Guidance for coding agents working in this repository. Read it before changing code.

## What this is

`opencode-queue` is a task queue the **user** owns for an OpenCode 2 session, which the agent may be allowed to drain
one task at a time. It is not a model-owned todo list.

## Hard product rules

- **Never auto-execute by default.** With auto-run off there is no draining, idle hook, background dispatch, or implicit
  submission.
- **`/queue-run` never submits.** There is no public V2 API for prefilling the native composer
  ([anomalyco/opencode#51209](https://github.com/anomalyco/opencode/issues/51209)). The command explains this and stops.
- **The agent sees nothing while auto-run is off.** The `queue_list` and `queue_done` tools must refuse when no run is
  armed for the calling session. This is the guarantee that keeps the default mode safe.
- **Tasks are session-scoped.** Other sessions never see them, and `session.deleted` purges them.
- **Editing a completed task resets it to pending.**

## Auto-run rules

Auto-run spends real model turns unattended. These are safety requirements, not preferences.

- **Fail closed.** `parseArming` returns `undefined` for anything it cannot fully validate. A file that cannot be proven
  to be valid consent is _off_. `budget` is clamped to `MAX_BUDGET`.
- **Budget the spend.** A run is capped at `budget` pushed tasks. Exhausting it stops the run.
- **Never re-push an unfinished task.** If `activeID` is still pending, stop and pause. Resubmitting would loop forever.
- **Pause on doubt.** An unreadable queue or a failed prompt pauses rather than retries.
- **One push at a time per session.** Guarded in-process; a concurrent idle event is dropped.

## Plugin API constraints, verified against OpenCode 2.0.1

These are host behaviours, not preferences. Do not "simplify" past them.

- **`context.keymap.layer` must be called from a component, never from `setup`.** The API documents it as "owned by the
  calling component". Plugin `setup` resumes after an `await` in an async activation path, so the Solid owner is gone and
  the call throws `Keymap.Provider is missing`. `ui/sidebar.tsx` mounts a `KeymapLayer` component through an `app` slot
  for exactly this reason.
- **Slash-command arguments do work.** They are routed through `Keymap.useCommands()`, whose `run(input)` calls
  `dispatch(id, input)`. An earlier note in this repo claimed otherwise; that was wrong.
- **Accordion state must not render from `context.storage`.** The host commits that store only after a cross-process
  lock and an fsynced write, so a click looks dead. Render from a local `createSignal` and persist in the background.

## Layout

```text
src/
  server.ts     server entrypoint: events, auto-run, agent tools
  tui.tsx       CLI entrypoint: state, handlers, slot registration
  core/         pure domain, no IO — task, backlog, autorun
  stores/       durable state — queue, autorun, view
  libs/         composed infrastructure — lock, watcher
  ui/           presentation — sidebar, commands
  utils/        leaf helpers — fs, json, text
test/
  autorun.test.ts   fail-closed parsing and every decideNext branch
  domain.test.ts    pure helpers
  queue.test.ts     persistence, corruption, cross-process locking
  server.test.ts    activation, auto-run gating, agent tools
```

`core/` must stay free of `node:fs` and of `@opencode/*` imports. If logic needs a decision, it belongs in `core/` and is
tested directly.

## Code rules

- No `any`, no non-null assertions, no unchecked index access.
- No empty catch blocks. If a failure is not actionable, log it.
- Validate untrusted JSON once, at the store boundary. Do not re-check downstream.
- `erasableSyntaxOnly` is on: no enums, no parameter properties, because the package ships raw TypeScript.
- Imports carry explicit `.ts` extensions; `allowImportingTsExtensions` is enabled for the same reason.
- No build step. The npm tarball ships raw `src/`.
- Comments explain _why_ something is surprising. They do not restate the code.

## Checks

```sh
bun run check
```

Formatting is oxfmt and is authoritative. Lint is oxlint with warnings denied. Typecheck is strict, including
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Tests are `node:test`.

Tests must not mock the filesystem: use real temp directories. Cross-process behaviour is proven with real child
processes, not concurrent promises in one process.

## Git

- Conventional commits: `type(scope): summary`.
- `fix/feat/` style prefixes are not used here; short hyphenated branch names only.
- Never commit `.opencode/queue.json`, `autorun.json`, lock directories, quarantine files, or tarballs.
