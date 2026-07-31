<script lang="ts">
  import { editorStore } from "./store.svelte";
  import X from "@lucide/svelte/icons/x";
  import FileIcon from "@lucide/svelte/icons/file";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
  import { t } from "$lib/i18n/index.svelte";

  const buffers = $derived(editorStore.buffers);

  // The strip is one tab stop and it is the selected tab that holds it. Falling
  // back to the first tab matters for the moment between a buffer opening and
  // the store naming it active, where otherwise no tab is reachable at all.
  const tabStopId = $derived(
    buffers.some((b) => b.id === editorStore.activeId)
      ? editorStore.activeId
      : buffers[0]?.id ?? null,
  );

  let stripEl: HTMLDivElement | null = $state(null);

  function activate(id: string) {
    editorStore.setActive(id);
  }

  function close(e: Event, id: string) {
    e.stopPropagation();
    e.preventDefault();
    void editorStore.close(id);
  }

  function middleClickClose(e: MouseEvent, id: string) {
    if (e.button !== 1) return;
    close(e, id);
  }

  // Each tab carries an id so the panel can point back at it with
  // aria-labelledby, and every tab claims that one panel in return. One id
  // rather than one per buffer because that is what the DOM does: EditorPanel is
  // a single container whose contents are swapped, so per-buffer ids would leave
  // every inactive tab's aria-controls pointing at nothing.
  const PANEL_ID = "editor-panel";

  function tabId(id: string): string {
    return `editor-tab-${id}`;
  }

  function tabs(): HTMLElement[] {
    if (!stripEl) return [];
    return Array.from(stripEl.querySelectorAll<HTMLElement>('[role="tab"]'));
  }

  /** Selection follows focus, which is the tab pattern for a strip whose panel
   *  is already mounted: moving here is the same act as switching buffer. */
  function moveTo(list: HTMLElement[], index: number) {
    const el = list[(index + list.length) % list.length];
    const id = el?.dataset.tabId;
    if (!id) return;
    activate(id);
    el.focus();
  }

  function onStripKeydown(e: KeyboardEvent) {
    const list = tabs();
    if (list.length === 0) return;
    const at = list.findIndex((el) => el.dataset.tabId === editorStore.activeId);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      moveTo(list, at + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveTo(list, at < 0 ? 0 : at - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      moveTo(list, 0);
    } else if (e.key === "End") {
      e.preventDefault();
      moveTo(list, list.length - 1);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // The strip is one tab stop, so the per-tab X is not in the tab order any
      // more. This is what replaces it.
      const id = list[at]?.dataset.tabId;
      if (!id) return;
      e.preventDefault();
      void editorStore.close(id);
    }
  }

  // The bar is horizontal; convert vertical wheel input instead of ignoring it.
  function wheelScroll(e: WheelEvent) {
    if (!stripEl || e.deltaY === 0 || e.deltaX !== 0) return;
    e.preventDefault();
    stripEl.scrollLeft += e.deltaY;
  }

  // Tabs opened from the git panel land offscreen without this.
  $effect(() => {
    const id = editorStore.activeId;
    if (!id || !stripEl) return;
    const el = stripEl.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
</script>

<div
  bind:this={stripEl}
  class="tab-strip flex h-8 shrink-0 items-stretch gap-px overflow-x-auto bg-[var(--color-titlebar)]"
  onwheel={wheelScroll}
  role="tablist"
  aria-label={t("editor.openFiles")}
>
  {#each buffers as b (b.id)}
    {@const active = editorStore.activeId === b.id}
    <!-- Presentation, not a bare div: an un-roled wrapper is a generic child of
         the tablist, which leaves the aria-selected on the button inside it
         describing a tab the tablist does not own. -->
    <div
      role="presentation"
      class="group flex shrink-0 items-center border-r border-border transition {active
        ? 'bg-[var(--color-background)] text-foreground'
        : 'text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground'}"
    >
      <button
        type="button"
        role="tab"
        id={tabId(b.id)}
        data-tab-id={b.id}
        aria-selected={active}
        aria-controls={PANEL_ID}
        tabindex={b.id === tabStopId ? 0 : -1}
        class="flex h-full items-center gap-1.5 pl-2.5 text-sm"
        onclick={() => activate(b.id)}
        onkeydown={onStripKeydown}
        onauxclick={(e) => middleClickClose(e, b.id)}
        title={b.path}
      >
        {#if b.kind === "diff"}
          <GitCompareArrows class="size-3.5 shrink-0" />
        {:else}
          <FileIcon class="size-3.5 shrink-0" />
        {/if}
        <span class="max-w-[200px] truncate">{b.displayName}</span>
        {#if editorStore.isDirty(b)}
          <span
            class="size-1.5 shrink-0 rounded-full bg-foreground/70"
            role="img"
            aria-label={t("editor.unsaved")}
          ></span>
        {/if}
      </button>
      <button
        type="button"
        class="ml-1 mr-1.5 rounded p-0.5 opacity-0 transition hover:bg-[var(--color-surface-3)] hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-80"
        tabindex="-1"
        onclick={(e) => close(e, b.id)}
        aria-label={t("editor.closeTab")}
      >
        <X class="size-3" />
      </button>
    </div>
  {/each}
</div>

<style>
  /* A 10px scrollbar inside a 32px bar eats a third of it. */
  .tab-strip {
    scrollbar-width: none;
  }
  .tab-strip::-webkit-scrollbar {
    display: none;
  }
</style>
