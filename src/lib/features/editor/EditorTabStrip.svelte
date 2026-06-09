<script lang="ts">
  import { editorStore, type Buffer } from "./store.svelte";
  import X from "@lucide/svelte/icons/x";
  import FileIcon from "@lucide/svelte/icons/file";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";

  const buffers = $derived(editorStore.buffers);

  function isDirty(b: Buffer): boolean {
    return b.kind === "file" && b.content !== b.savedContent;
  }

  function activate(id: string) {
    editorStore.setActive(id);
  }

  function close(e: MouseEvent, id: string) {
    e.stopPropagation();
    e.preventDefault();
    void editorStore.close(id);
  }
</script>

<div
  class="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto bg-[var(--color-titlebar)]"
>
  {#each buffers as b (b.id)}
    {@const active = editorStore.activeId === b.id}
    <button
      type="button"
      class="group flex shrink-0 items-center gap-1.5 border-r border-border px-2.5 text-[11.5px] transition {active
        ? 'bg-[var(--color-background)] text-foreground'
        : 'text-muted-foreground hover:bg-[var(--color-surface-2)] hover:text-foreground'}"
      onclick={() => activate(b.id)}
      title={b.path}
    >
      {#if b.kind === "diff"}
        <GitCompareArrows class="size-3.5 shrink-0" />
      {:else}
        <FileIcon class="size-3.5 shrink-0" />
      {/if}
      <span class="truncate max-w-[200px]">{b.displayName}</span>
      {#if isDirty(b)}
        <span
          class="size-1.5 shrink-0 rounded-full bg-foreground/70"
          aria-label="unsaved"
        ></span>
      {/if}
      <span
        role="button"
        tabindex="-1"
        class="ml-1 -mr-1 rounded p-0.5 opacity-0 transition hover:bg-[var(--color-surface-3)] group-hover:opacity-80 hover:opacity-100"
        onclick={(e) => close(e, b.id)}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") close(e as unknown as MouseEvent, b.id);
        }}
        aria-label="Close tab"
      >
        <X class="size-3" />
      </span>
    </button>
  {/each}
</div>
