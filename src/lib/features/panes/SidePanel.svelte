<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings, clampRightPanelWidth } from "$lib/features/settings/store.svelte";
  import { resizeHandle } from "$lib/shared/actions/resizeHandle";
  import GitPanel from "$lib/features/git/GitPanel.svelte";
  import ExplorerPanel from "$lib/features/explorer/ExplorerPanel.svelte";
  import TodoPanel from "$lib/features/todo/TodoPanel.svelte";
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
   * already behave as tabs and drawing them twice was one control too many.
   *
   * This column draws no chrome of its own. It used to carry a header naming
   * the panel and holding the two verbs, above the panel's own header naming
   * the project and holding its actions: two bars, eight pixels apart, saying
   * different halves of one thing. The panel keeps its header and is handed its
   * close action to put at the end
   * of it.
   *
   */

  let panelEl: HTMLElement | null = $state(null);
  let resizing = $state(false);
  let viewportWidth = $state(0);

  const current = $derived(settings.rightPanelFor(app.currentProjectId));
  // Re-clamped against the live window, not only against the one the width was
  // dragged in: the stored value is per machine, and a restored window can be
  // narrower than the monitor it was sized on.
  const width = $derived(
    viewportWidth > 0
      ? Math.min(settings.state.rightPanelWidth, clampRightPanelWidth(viewportWidth))
      : settings.state.rightPanelWidth,
  );

  function onResize(e: PointerEvent) {
    if (!panelEl) return;
    const rect = panelEl.getBoundingClientRect();
    settings.setRightPanelWidth(rect.right - e.clientX);
  }

  function close() {
    settings.setRightPanel(app.currentProjectId, null);
  }

</script>

<svelte:window bind:innerWidth={viewportWidth} />

<aside
  bind:this={panelEl}
  class="relative flex h-full shrink-0 flex-col border-l border-border bg-[var(--color-surface)]"
  class:select-none={resizing}
  style:width="{width}px"
>
  <div class="min-h-0 min-w-0 flex-1">
    {#if current === "git"}
      <GitPanel onClose={close} />
    {:else if current === "explorer"}
      <ExplorerPanel onClose={close} />
    {:else if current === "todo"}
      <TodoPanel onClose={close} />
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
