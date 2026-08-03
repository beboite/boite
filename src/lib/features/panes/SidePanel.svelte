<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { resizeHandle } from "$lib/shared/actions/resizeHandle";
  import { openPane } from "./open";
  import type { PanelKind } from "./types";
  import GitPanel from "$lib/features/git/GitPanel.svelte";
  import ExplorerPanel from "$lib/features/explorer/ExplorerPanel.svelte";
  import TodoPanel from "$lib/features/todo/TodoPanel.svelte";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import SquareArrowOutUpRight from "@lucide/svelte/icons/square-arrow-out-up-right";
  import X from "@lucide/svelte/icons/x";
  import type { MessageKey } from "$lib/i18n/messages";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * Git, files and the todo list, in one column with one width.
   *
   * These three describe the project you are on, not a document you are working
   * in: there is one of each and they are about the same thing, so they share a
   * column and a tab strip. When they were panes instead, every one you opened
   * subdivided the layout — three neighbouring buttons that each rearranged the
   * window differently, and a geometry that was never twice the same. Picking a
   * tab here changes what the column holds and nothing else.
   *
   * The tab strip is the three titlebar buttons, not a second row of the same
   * three in here: clicking Todo while Git is up switches the column, so they
   * already behave as tabs and drawing them twice was one control too many. The
   * header names what is showing and carries the two verbs the titlebar has no
   * room for.
   *
   * The pane is not gone, it is a deliberate act now: the detach button hands
   * the panel to the pane tree, which is the one thing this column cannot do —
   * sit beside one particular terminal rather than beside all of them.
   */

  const NAMES: Record<PanelKind, { labelKey: MessageKey; icon: typeof GitBranch }> = {
    git: { labelKey: "panes.kindGit", icon: GitBranch },
    explorer: { labelKey: "panes.kindExplorer", icon: FolderTree },
    todo: { labelKey: "panes.kindTodo", icon: ListTodo },
  };

  let panelEl: HTMLElement | null = $state(null);
  let resizing = $state(false);

  const current = $derived(settings.state.rightPanel);
  const named = $derived(current ? NAMES[current] : null);

  function onResize(e: PointerEvent) {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    settings.setRightPanelWidth(rect.right - e.clientX);
  }

  // Detaching closes the column: the same panel docked and floating at once is
  // two views of one thing fighting over which is the real one.
  function detach() {
    const kind = current;
    if (!kind) return;
    settings.setRightPanel(null);
    openPane({ kind });
  }
</script>

<aside
  bind:this={panelEl}
  class="relative flex h-full shrink-0 flex-col border-l border-border bg-[var(--color-surface)]"
  class:select-none={resizing}
  style:width="{settings.state.rightPanelWidth}px"
>
  <div
    class="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-[var(--color-titlebar)] px-1.5"
  >
    {#if named}
      {@const Icon = named.icon}
      <span class="flex items-center gap-1.5 px-1 text-xs font-medium text-foreground">
        <Icon class="size-3.5" />
        {t(named.labelKey)}
      </span>
    {/if}

    <button
      type="button"
      class="ml-auto rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={detach}
      title={t("panel.detach")}
      aria-label={t("panel.detach")}
    >
      <SquareArrowOutUpRight class="size-3.5" />
    </button>
    <button
      type="button"
      class="rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
      onclick={() => settings.setRightPanel(null)}
      title={t("panel.close")}
      aria-label={t("panel.close")}
    >
      <X class="size-3.5" />
    </button>
  </div>

  <div class="min-h-0 min-w-0 flex-1">
    {#if current === "git"}
      <GitPanel />
    {:else if current === "explorer"}
      <ExplorerPanel />
    {:else if current === "todo"}
      <TodoPanel />
    {/if}
  </div>

  <button
    type="button"
    class="absolute -left-px top-0 z-10 h-full w-1 cursor-col-resize transition hover:bg-foreground/10 after:absolute after:inset-y-0 after:-inset-x-1.5 after:content-[''] {resizing
      ? 'bg-foreground/20'
      : 'bg-transparent'}"
    use:resizeHandle={{
      onResize,
      onStateChange: (r) => (resizing = r),
    }}
    aria-label={t("panel.resize")}
    title={t("panel.resize")}
    tabindex="-1"
  ></button>
</aside>
