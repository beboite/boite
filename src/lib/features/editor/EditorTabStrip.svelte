<script lang="ts">
  import { editorStore, type Buffer } from "./store.svelte";
  import X from "@lucide/svelte/icons/x";
  import FileIcon from "@lucide/svelte/icons/file";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";

  const buffers = $derived(editorStore.buffers);

  let stripEl: HTMLDivElement | null = $state(null);

  function isDirty(b: Buffer): boolean {
    return b.kind === "file" && b.content !== b.savedContent;
  }

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
  aria-label="Open files"
>
  {#each buffers as b (b.id)}
    {@const active = editorStore.activeId === b.id}
    <div
      data-tab-id={b.id}
      class="group flex shrink-0 items-center border-r border-border transition {active
        ? 'bg-[var(--color-background)] text-foreground'
        : 'text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground'}"
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        class="flex h-full items-center gap-1.5 pl-2.5 text-[11.5px]"
        onclick={() => activate(b.id)}
        onauxclick={(e) => middleClickClose(e, b.id)}
        title={b.path}
      >
        {#if b.kind === "diff"}
          <GitCompareArrows class="size-3.5 shrink-0" />
        {:else}
          <FileIcon class="size-3.5 shrink-0" />
        {/if}
        <span class="max-w-[200px] truncate">{b.displayName}</span>
        {#if isDirty(b)}
          <span
            class="size-1.5 shrink-0 rounded-full bg-foreground/70"
            aria-label="unsaved"
          ></span>
        {/if}
      </button>
      <button
        type="button"
        class="ml-1 mr-1.5 rounded p-0.5 opacity-0 transition hover:bg-[var(--color-surface-3)] hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-80"
        onclick={(e) => close(e, b.id)}
        aria-label="Close tab"
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
