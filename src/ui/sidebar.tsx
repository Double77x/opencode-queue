/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context";
import { usePlugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { For, Show, createMemo, createResource } from "solid-js";
import { badgeText, type Arming } from "../core/autorun.ts";
import { marker, position } from "../core/backlog.ts";
import { DONE, type Task } from "../core/task.ts";
import type { ViewState } from "../stores/view.ts";
import { truncate } from "../utils/text.ts";

const SIDEBAR_MAX_CHARS = 100;
const COLLAPSED = "▶";
const EXPANDED = "▼";

type InboxItem = ReturnType<Context["data"]["session"]["pending"]["list"]>[number];
type StashedRequest = Extract<InboxItem, { type: "user" }>;

function isRequest(item: InboxItem): item is StashedRequest {
  return item.type === "user";
}

function requestMarker(delivery: StashedRequest["delivery"]): string {
  return delivery === "queue" ? "→ " : "↳ ";
}

type Section = {
  title: string;
  count: number;
  expanded: boolean;
  /** Short state summary shown in the header, but only while collapsed. */
  badge?: string | undefined;
  onToggle: () => void;
  empty: string;
  children?: JSX.Element;
};

function Disclosure(props: Section) {
  const plugin = usePlugin();
  const countColor = () => (props.count > 0 ? plugin.theme.text.feedback.info.default : plugin.theme.text.subdued);
  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row" gap={1} onMouseDown={props.onToggle}>
        <text fg={plugin.theme.text.subdued}>{props.expanded ? EXPANDED : COLLAPSED}</text>
        <text fg={plugin.theme.text.default}>
          <b>{props.title}</b>
        </text>
        <box flexGrow={1} />
        <Show when={!props.expanded && props.badge !== undefined} keyed>
          {(text: string) => <text fg={plugin.theme.text.feedback.warning.default}>{text}</text>}
        </Show>
        <text fg={countColor()}>{props.count}</text>
      </box>
      <Show when={props.expanded}>
        <box flexDirection="column" paddingLeft={1} paddingTop={1}>
          <Show when={props.children} fallback={<text fg={plugin.theme.text.subdued}>{props.empty}</text>}>
            {props.children}
          </Show>
        </box>
      </Show>
    </box>
  );
}

export function QueueSection(props: {
  sessionID: string;
  tasks: readonly Task[];
  arming: Arming | undefined;
  view: ViewState;
  onToggleQueue: () => void;
  onToggleStashed: () => void;
}) {
  const plugin = usePlugin();
  const [synced] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      await plugin.data.session.pending.sync(sessionID);
      return true;
    },
  );
  const mine = createMemo(() => props.tasks.filter((task) => task.sessionID === props.sessionID));
  const stashed = createMemo(() =>
    synced() ? plugin.data.session.pending.list(props.sessionID).filter(isRequest) : [],
  );
  const badge = createMemo(() => badgeText(props.arming));

  return (
    <box flexDirection="column">
      <Disclosure
        title="My Queue"
        count={mine().length}
        expanded={props.view.queueExpanded}
        badge={badge()}
        onToggle={props.onToggleQueue}
        empty="No tasks"
      >
        <For each={position(mine())}>
          {(entry) => {
            const done = () => entry.task.status === DONE;
            return (
              <box flexDirection="row" gap={0}>
                <text
                  flexShrink={0}
                  fg={done() ? plugin.theme.text.feedback.success.default : plugin.theme.text.feedback.info.default}
                >
                  {marker(entry.task.status)}{" "}
                </text>
                <text flexShrink={0} fg={plugin.theme.text.subdued}>
                  {entry.position}.{" "}
                </text>
                <text
                  flexGrow={1}
                  wrapMode="word"
                  fg={done() ? plugin.theme.text.subdued : plugin.theme.text.default}
                  attributes={done() ? TextAttributes.STRIKETHROUGH : 0}
                >
                  {truncate(entry.task.text, SIDEBAR_MAX_CHARS)}
                </text>
              </box>
            );
          }}
        </For>
      </Disclosure>
      <Disclosure
        title="Stashed requests"
        count={stashed().length}
        expanded={props.view.stashedExpanded}
        onToggle={props.onToggleStashed}
        empty={synced.error ? "Requests unavailable" : "No stashed requests"}
      >
        <For each={stashed()}>
          {(request) => (
            <box flexDirection="row" gap={0}>
              <text
                flexShrink={0}
                fg={
                  request.delivery === "queue"
                    ? plugin.theme.text.feedback.warning.default
                    : plugin.theme.text.feedback.info.default
                }
              >
                {requestMarker(request.delivery)}
              </text>
              <text flexGrow={1} wrapMode="word" fg={plugin.theme.text.default}>
                {truncate(request.payload.text, SIDEBAR_MAX_CHARS)}
              </text>
            </box>
          )}
        </For>
      </Disclosure>
    </box>
  );
}

/**
 * `context.keymap.layer` is owned by the calling component, and plugin `setup`
 * resumes after an await with no Solid owner, so the layer has to be created
 * from a component mounted through a slot rather than from `setup` itself.
 */
export function KeymapLayer(props: { commands: readonly KeymapCommand[] }) {
  const plugin = usePlugin();
  plugin.keymap.layer(() => ({ mode: "global", priority: 10, commands: props.commands }));
  return null;
}
