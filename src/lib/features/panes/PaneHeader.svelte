<script lang="ts">
  import { paneStore } from "./store.svelte";
  import type { PaneContent } from "./types";
  import { app } from "$lib/app/store.svelte";
  import { justFinished } from "$lib/features/thread/finished.svelte";
  import { mcpPulse } from "$lib/features/thread/agentActivity.svelte";
  import ThreadGlyph from "$lib/features/thread/ThreadGlyph.svelte";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { t } from "$lib/i18n/index.svelte";
  import X from "@lucide/svelte/icons/x";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import FileText from "@lucide/svelte/icons/file-text";
  import Globe from "@lucide/svelte/icons/globe";

  /**
   * The strip that says which pane this is.
   *
   * A split used to have none: four terminals side by side with a one-pixel ring
   * on the focused one, and no way to tell which agent was in which without
   * reading its output. That is most of why nobody used the split.
   */
  type Props = {
    paneId: string;
    content: PaneContent;
    groupId: string;
    focused: boolean;
    /** Single-pane groups holding a terminal draw no header; the sidebar names
        the thread and chrome around one terminal is chrome for nothing. */
    closable: boolean;
  };
  let { paneId, content, groupId, focused, closable }: Props = $props();

  const thread = $derived(
    content.kind === "thread" ? app.threadById(content.threadId) : null,
  );

  const label = $derived.by(() => {
    switch (content.kind) {
      case "thread":
        return thread?.title ?? thread?.label ?? "";
      case "dashboard":
        return t("panes.kindDashboard");
      case "git":
        return t("panes.kindGit");
      case "explorer":
        return t("panes.kindExplorer");
      case "todo":
        return t("panes.kindTodo");
      case "editor":
        return t("panes.kindEditor");
      case "browser":
        return hostOf(content.url);
    }
  });

  // The host, not the URL: a pane header is 28px tall and a full URL truncates
  // to its scheme. The whole thing stays on the title attribute.
  function hostOf(url: string): string {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  }

  const fullTitle = $derived(content.kind === "browser" ? content.url : label);

  /**
   * Whether an agent just reached in through this pane.
   *
   * Two different questions with one answer: a thread pane asks "did the agent
   * in me make the call", a panel pane asks "was the thing I am showing what
   * the call changed". Both are the same violet flash, because from the user's
   * side both mean the same thing — the app moved and nobody clicked.
   */
  const pulsing = $derived.by(() => {
    if (content.kind === "thread") return mcpPulse.has(paneId);
    if (content.kind === "todo") return mcpPulse.surface("todo");
    if (content.kind === "dashboard") {
      return (
        mcpPulse.surface("todo") ||
        mcpPulse.surface("worktree") ||
        mcpPulse.surface("thread")
      );
    }
    if (content.kind === "git") return mcpPulse.surface("worktree");
    return false;
  });

  function close() {
    paneStore.closePane(paneId);
  }

  function focus() {
    paneStore.setFocused(groupId, paneId);
  }
</script>

<!-- Not a button: the whole strip is a focus target, and a button here would
     nest the close button inside it. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="pane-header"
  class:focused
  class:finished={content.kind === "thread" && justFinished(content.threadId)}
  class:mcp={pulsing}
  onpointerdown={focus}
>
  {#if content.kind === "thread" && thread}
    <ThreadGlyph
      inert
      size={14}
      status={thread.status}
      iconKey={thread.iconKey}
      color={threadIconColor(thread)}
      asleep={thread.autoSlept ?? false}
      keepAwake={(thread.keepAwake ?? false) && !!thread.ptyId}
    />
  {:else if content.kind === "dashboard"}
    <LayoutDashboard class="size-3.5 shrink-0 text-muted-foreground" />
  {:else if content.kind === "git"}
    <GitBranch class="size-3.5 shrink-0 text-muted-foreground" />
  {:else if content.kind === "explorer"}
    <FolderTree class="size-3.5 shrink-0 text-muted-foreground" />
  {:else if content.kind === "todo"}
    <ListTodo class="size-3.5 shrink-0 text-muted-foreground" />
  {:else if content.kind === "editor"}
    <FileText class="size-3.5 shrink-0 text-muted-foreground" />
  {:else if content.kind === "browser"}
    <Globe class="size-3.5 shrink-0 text-muted-foreground" />
  {/if}

  <span class="min-w-0 flex-1 truncate text-xs" title={fullTitle}>{label}</span>

  {#if closable}
    <button
      type="button"
      class="flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground/70 transition hover:bg-danger/20 hover:text-danger"
      onclick={close}
      title={t("panes.closePane")}
      aria-label={t("panes.closePane")}
    >
      <X class="size-3" />
    </button>
  {/if}
</div>

<style>
  .pane-header {
    display: flex;
    height: 26px;
    flex: none;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 8px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-titlebar);
    color: var(--color-muted-foreground);
    transition:
      color var(--dur-2) var(--ease-out-quint),
      box-shadow var(--dur-2) var(--ease-out-quint);
  }
  /* Which pane has the keyboard, said on the header instead of as a ring around
     the terminal: a one-pixel inset line on a black canvas was the whole answer
     before, and it was invisible next to a second black canvas. */
  .pane-header.focused {
    color: var(--color-foreground);
    background: var(--color-surface-2);
    box-shadow: inset 0 -1px 0 0 var(--color-border-strong);
  }
  .pane-header.finished {
    animation: boite-finish-glow 6s var(--ease-out-quint) forwards;
  }
  .pane-header.mcp {
    animation: boite-mcp-pulse 1.6s var(--ease-out-quint) forwards;
  }
</style>
