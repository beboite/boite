<script lang="ts">
  import type { Component } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { paneStore } from "./store.svelte";
  import { closeMobilePane } from "./open";
  import { paneLabel } from "./label";
  import { threadIdOf } from "./types";
  import type { LayoutNode, PaneGroup, PaneKind } from "./types";
  import { edgeFade } from "$lib/shared/actions/edgeFade";
  import { t } from "$lib/i18n/index.svelte";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import FileCode from "@lucide/svelte/icons/file-code";
  import Globe from "@lucide/svelte/icons/globe";
  import X from "@lucide/svelte/icons/x";

  /**
   * The phone's way through a group that holds several panes.
   *
   * A window puts four panes side by side and the user picks one with their
   * eyes. 420px cannot: the same group squeezed every pane to a column one word
   * wide. So the phone draws one pane full width and this strip is what the eyes
   * do instead: the group's panes as chips, the visible one filled.
   *
   * Only the active chip carries a close, and only when the pane is not a
   * terminal: closing a thread pane means moving the terminal to a group of its
   * own, which on a phone would look like nothing happened at all.
   */
  type Leaf = Extract<LayoutNode, { kind: "leaf" }>;
  type Props = { group: PaneGroup; leaves: Leaf[]; activePaneId: string };
  let { group, leaves, activePaneId }: Props = $props();

  /**
   * A terminal chip selects the thread as well as the pane.
   *
   * The top bar names `app.activeThread` and the status ticker follows it, so a
   * strip that only moved the pane focus would show one terminal and describe
   * another.
   */
  function show(leaf: Leaf) {
    paneStore.setFocused(group.id, leaf.paneId);
    const threadId = threadIdOf(leaf.content);
    if (threadId) app.activeThreadId = threadId;
  }

  const ICONS: Record<PaneKind, Component> = {
    thread: SquareTerminal,
    chat: MessageSquare,
    dashboard: LayoutDashboard,
    git: GitBranch,
    explorer: FolderTree,
    todo: ListTodo,
    editor: FileCode,
    browser: Globe,
  };
</script>

<!-- `role="group"` rather than a tablist: these chips switch what the pane area
     draws, but every pane stays mounted and none of them is a tabpanel that
     appears with its tab. A group with a name is what a screen reader needs to
     say where the buttons lead. -->
<div
  class="pane-strip hide-scrollbar edge-fade flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border bg-[var(--color-titlebar)] px-1.5 py-1"
  role="group"
  aria-label={t("panes.strip")}
  use:edgeFade
>
  {#each leaves as leaf (leaf.paneId)}
    {@const active = leaf.paneId === activePaneId}
    {@const Icon = ICONS[leaf.content.kind]}
    {@const name = paneLabel(leaf.content)}
    <div
      class="flex min-h-11 shrink-0 items-center rounded-lg border {active
        ? 'border-edge bg-[var(--color-surface-2)]'
        : 'border-transparent'}"
    >
      <button
        type="button"
        class="focus-ring-inset flex min-h-11 max-w-[9rem] items-center gap-1.5 rounded-lg px-2.5 {active
          ? 'text-foreground'
          : 'text-muted-foreground'}"
        onclick={() => show(leaf)}
        aria-current={active ? "true" : undefined}
        aria-label={t("panes.showPane", { name })}
      >
        <Icon class="size-4 shrink-0" />
        <span class="truncate text-sm">{name}</span>
      </button>
      {#if active && leaf.content.kind !== "thread"}
        <button
          type="button"
          class="focus-ring-inset flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-2 transition hover:text-foreground active:bg-accent/70"
          onclick={() => closeMobilePane(leaf.paneId)}
          aria-label={t("panes.closePane")}
        >
          <X class="size-4" />
        </button>
      {/if}
    </div>
  {/each}
</div>
