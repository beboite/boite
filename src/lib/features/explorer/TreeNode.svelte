<script lang="ts">
  import { explorerStore } from "./store.svelte";
  import { threadCwd } from "$lib/features/thread/cwd";
  import { treeMenu } from "./treeMenu.svelte";
  import { revealItemInDir } from "$lib/platform/opener";
  import { writeText } from "$lib/platform/clipboard";
  import { longPress } from "$lib/shared/actions/longPress";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { app } from "$lib/app/store.svelte";
  import TreeNode from "./TreeNode.svelte";
  import FileTypeIcon from "./FileTypeIcon.svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Folder from "@lucide/svelte/icons/folder";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
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
  const status = $derived(explorerStore.statusFor(entry.path, entry.isDir));
  const visible = $derived(explorerStore.isVisible(entry.path, entry.isDir));

  function statusColor(s: string): string {
    if (s === "U" || s === "D") return "var(--color-danger)";
    if (s === "A" || s === "?") return "var(--color-success)";
    return "var(--color-warning)";
  }

  function statusLabel(s: string): string {
    if (s === "?") return "U";
    return s;
  }

  // OS-facing calls (explorer.exe) want native separators back.
  function toNative(p: string): string {
    return /^[a-zA-Z]:\//.test(p) ? p.replaceAll("/", "\\") : p;
  }

  async function activate() {
    if (entry.isDir) {
      await explorerStore.toggle(entry.path);
      return;
    }
    await editorStore.openFile(entry.path);
    app.view = "editor";
  }

  async function reveal() {
    try {
      await revealItemInDir(toNative(entry.path));
    } catch (err) {
      logger.warn("explorer", `revealItemInDir failed for ${entry.path}`, String(err));
    }
  }

  async function copyPath(p: string) {
    try {
      await writeText(p);
      notifications.success("Path copied");
    } catch (err) {
      logger.warn("explorer", `copy path failed for ${p}`, String(err));
    }
  }

  function relativePath(): string {
    const project = app.currentProjectId
      ? app.projects.find((p) => p.id === app.currentProjectId)
      : null;
    if (!project) return entry.path;
    const active = app.activeThread?.projectId === project.id ? app.activeThread : null;
    const base = threadCwd(active, project) ?? project.cwd;
    const root = base.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    return entry.path.startsWith(root)
      ? entry.path.slice(root.length)
      : entry.path;
  }

  function openMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openMenuAt(e.clientX, e.clientY);
  }

  function openMenuAt(x: number, y: number) {
    const items: ContextMenuItem[] = [];
    if (!entry.isDir) {
      items.push({
        label: "Open",
        action: () => {
          void editorStore.openFile(entry.path).then(() => (app.view = "editor"));
        },
      });
      items.push({ separator: true });
    }
    items.push({
      label: "Reveal in file manager",
      action: () => void reveal(),
    });
    items.push({ separator: true });
    items.push({
      label: "Copy path",
      action: () => void copyPath(toNative(entry.path)),
    });
    items.push({
      label: "Copy relative path",
      action: () => void copyPath(relativePath()),
    });
    treeMenu.open(x, y, items);
  }
</script>

{#if visible}
<div>
  <button
    type="button"
    data-tree-row
    data-path={entry.path}
    data-dir={entry.isDir ? "1" : "0"}
    class="group flex w-full items-center gap-1 px-1 py-0.5 text-left text-sm transition hover:bg-[var(--color-surface-2)] focus-visible:bg-[var(--color-surface-2)] focus-visible:outline-none {entry.isHidden ? 'text-foreground/55' : 'text-foreground/85'}"
    style:padding-left="{depth * 12 + 4}px"
    role="treeitem"
    aria-expanded={entry.isDir ? isOpen : undefined}
    aria-level={depth + 1}
    aria-selected="false"
    onclick={activate}
    oncontextmenu={openMenu}
    use:longPress={{ onLongPress: openMenuAt }}
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
      <FileTypeIcon filename={entry.name} size={14} />
    {/if}
    <span class="truncate">{entry.name}</span>
    {#if status}
      <span
        class="ml-auto pl-1 font-mono text-2xs leading-none tabular-nums"
        style:color={statusColor(status)}
        aria-label="git status {status}"
      >
        {statusLabel(status)}
      </span>
    {/if}
  </button>

  {#if entry.isDir && isOpen}
    {#if isLoading && !children}
      <div
        class="px-1 py-0.5 text-xs text-muted-foreground/70"
        style:padding-left="{depth * 12 + 24}px"
      >
        Loading…
      </div>
    {:else if errMsg}
      <div
        class="px-1 py-0.5 text-xs text-[var(--color-danger)]"
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
          class="px-1 py-0.5 text-xs text-muted-foreground/60 italic"
          style:padding-left="{depth * 12 + 24}px"
        >
          empty
        </div>
      {/if}
    {/if}
  {/if}
</div>
{/if}
