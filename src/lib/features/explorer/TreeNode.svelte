<script lang="ts">
  import { explorerStore } from "./store.svelte";
  import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { app } from "$lib/app/store.svelte";
  import TreeNode from "./TreeNode.svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Folder from "@lucide/svelte/icons/folder";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import FileIcon from "@lucide/svelte/icons/file";
  import type { DirEntry } from "./api";

  interface Props {
    entry: DirEntry;
    depth: number;
  }

  let { entry, depth }: Props = $props();

  const isOpen = $derived(!!explorerStore.expanded[entry.path]);
  const children = $derived(explorerStore.entriesByPath[entry.path] ?? null);
  const isLoading = $derived(!!explorerStore.loading[entry.path]);
  const errMsg = $derived(explorerStore.errorByPath[entry.path] ?? null);

  async function activate(e: MouseEvent) {
    if (entry.isDir) {
      await explorerStore.toggle(entry.path);
      return;
    }
    if (e.altKey) {
      try {
        await openPath(entry.path);
      } catch (err) {
        logger.warn("explorer", `openPath failed for ${entry.path}`, String(err));
      }
      return;
    }
    await editorStore.openFile(entry.path);
    app.view = "editor";
  }

  async function reveal(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await revealItemInDir(entry.path);
    } catch (err) {
      logger.warn("explorer", `revealItemInDir failed for ${entry.path}`, String(err));
    }
  }
</script>

<div>
  <button
    type="button"
    class="group flex w-full items-center gap-1 px-1 py-0.5 text-left text-[11.5px] transition hover:bg-[var(--color-surface-2)] {entry.isHidden ? 'text-foreground/55' : 'text-foreground/85'}"
    style:padding-left="{depth * 12 + 4}px"
    onclick={activate}
    oncontextmenu={reveal}
    title={entry.path}
  >
    {#if entry.isDir}
      <ChevronRight
        class="size-3 shrink-0 text-muted-foreground transition {isOpen ? 'rotate-90' : ''}"
      />
      {#if isOpen}
        <FolderOpen class="size-3.5 shrink-0 text-foreground/70" />
      {:else}
        <Folder class="size-3.5 shrink-0 text-foreground/70" />
      {/if}
    {:else}
      <span class="size-3 shrink-0"></span>
      <FileIcon class="size-3.5 shrink-0 text-muted-foreground/85" />
    {/if}
    <span class="truncate">{entry.name}</span>
  </button>

  {#if entry.isDir && isOpen}
    {#if isLoading && !children}
      <div
        class="px-1 py-0.5 text-[10.5px] text-muted-foreground/70"
        style:padding-left="{depth * 12 + 24}px"
      >
        Loading…
      </div>
    {:else if errMsg}
      <div
        class="px-1 py-0.5 text-[10.5px] text-[var(--color-danger)]"
        style:padding-left="{depth * 12 + 24}px"
      >
        {errMsg}
      </div>
    {:else if children}
      {#each children as child (child.path)}
        <TreeNode entry={child} depth={depth + 1} />
      {/each}
      {#if children.length === 0}
        <div
          class="px-1 py-0.5 text-[10.5px] text-muted-foreground/60 italic"
          style:padding-left="{depth * 12 + 24}px"
        >
          empty
        </div>
      {/if}
    {/if}
  {/if}
</div>
