<script module lang="ts">
  import { getContext, setContext } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";

  /**
   * The tree's cursor, owned by ExplorerPanel.
   *
   * The container keeps DOM focus and names the current row through
   * aria-activedescendant, so a row only ever needs to answer "am I the one".
   * Context rather than a prop because the tree is recursive and threading the
   * cursor through every level would re-render whole branches on each move.
   */
  export interface TreeCursor {
    readonly activePath: string | null;
    readonly focused: boolean;
    setActive(path: string): void;
  }

  const TREE_CURSOR = Symbol("explorer.treeCursor");

  export function provideTreeCursor(cursor: TreeCursor): void {
    setContext(TREE_CURSOR, cursor);
  }

  function treeCursor(): TreeCursor | null {
    return getContext<TreeCursor | null>(TREE_CURSOR) ?? null;
  }

  /**
   * A DOM id for a row. An id may not carry whitespace, and two different paths
   * must never collapse onto one or aria-activedescendant would name the wrong
   * row, so literal underscores are doubled before spaces become one.
   */
  export function treeRowId(path: string): string {
    return `tree-${path.replace(/_/g, "__").replace(/\s/g, "_")}`;
  }
</script>

<script lang="ts">
  import { explorerStore } from "./store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import { threadCwd } from "$lib/features/thread/cwd";
  import { treeMenu } from "./treeMenu.svelte";
  import { canRevealItem, revealItemInDir } from "$lib/platform/opener";
  import { writeText } from "$lib/platform/clipboard";
  import { longPress } from "$lib/shared/actions/longPress";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { editorStore } from "$lib/features/editor/store.svelte";
  import { revealEditor } from "$lib/features/editor/reveal";
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

  const cursor = treeCursor();
  const selected = $derived(cursor?.activePath === entry.path);
  // The row highlight only shows while the tree itself has focus: at rest the
  // panel has to look exactly as it did before there was a cursor.
  const current = $derived(selected && !!cursor?.focused);
  const rowId = $derived(treeRowId(entry.path));
  const groupId = $derived(`${rowId}-group`);

  // A 19px row is a fine density for a mouse and unhittable with a thumb, and
  // this tree is the whole Files tab on a phone.
  const mobile = $derived(settings.state.mobileLayout);

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

  // The badge is a one-letter git code, which is meaningless read aloud. Keys
  // are literals so a typo fails the type check.
  const STATUS_KEYS: Record<string, MessageKey> = {
    M: "explorer.gitModified",
    A: "explorer.gitAdded",
    D: "explorer.gitDeleted",
    R: "explorer.gitRenamed",
    C: "explorer.gitCopied",
    U: "explorer.gitConflicted",
    "?": "explorer.gitUntracked",
  };

  function statusAria(s: string): string {
    const key = STATUS_KEYS[s];
    return key ? t(key) : t("explorer.gitChanged");
  }

  // OS-facing calls (explorer.exe) want native separators back.
  function toNative(p: string): string {
    return /^[a-zA-Z]:\//.test(p) ? p.replaceAll("/", "\\") : p;
  }

  async function activate() {
    // A click is also a cursor move, otherwise the next arrow key would resume
    // from wherever the keyboard left off rather than from the clicked row.
    cursor?.setActive(entry.path);
    if (entry.isDir) {
      await explorerStore.toggle(entry.path);
      return;
    }
    await editorStore.open(entry.path);
    revealEditor();
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
      notifications.success(t("explorer.pathCopied"));
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
        label: t("explorer.open"),
        action: () => {
          void editorStore.open(entry.path).then(() => revealEditor());
        },
      });
      items.push({ separator: true });
    }
    // Left out entirely off this machine: the file manager it would open is
    // the local one, and the path it would be handed is the boite's.
    if (canRevealItem(entry.path)) {
      items.push({
        label: t("explorer.revealInFileManager"),
        action: () => void reveal(),
      });
      items.push({ separator: true });
    }
    items.push({
      label: t("explorer.copyPath"),
      action: () => void copyPath(toNative(entry.path)),
    });
    items.push({
      label: t("explorer.copyRelativePath"),
      action: () => void copyPath(relativePath()),
    });
    treeMenu.open(x, y, items);
  }
</script>

{#if visible}
<!-- Presentation so the treeitem and its group flatten up to the tree: a plain
     div here is a generic child of role="tree", which owns neither. -->
<div role="presentation">
  <button
    type="button"
    id={rowId}
    data-tree-row
    data-path={entry.path}
    data-name={entry.name}
    data-dir={entry.isDir ? "1" : "0"}
    tabindex="-1"
    class="group flex w-full items-center px-1 text-left transition hover:bg-accent focus-visible:bg-[var(--color-surface-2)] focus-visible:focus-ring-inset {current
      ? 'bg-[var(--color-surface-2)]'
      : ''} {mobile
      ? 'min-h-11 gap-2 py-2 text-base'
      : 'gap-1 py-0.5 text-sm'} {entry.isHidden ? 'text-muted-foreground' : 'text-foreground'}"
    style:padding-left="{depth * 12 + 4}px"
    role="treeitem"
    aria-expanded={entry.isDir ? isOpen : undefined}
    aria-level={depth + 1}
    aria-selected={selected}
    aria-owns={entry.isDir && isOpen ? groupId : undefined}
    onclick={activate}
    oncontextmenu={openMenu}
    use:longPress={{ onLongPress: openMenuAt }}
    use:tip={entry.path}
  >
    {#if entry.isDir}
      <ChevronRight
        class="size-3 shrink-0 text-muted-foreground transition {isOpen ? 'rotate-90' : ''}"
      />
      {#if isOpen}
        <FolderOpen class="size-3.5 shrink-0 text-muted-foreground" />
      {:else}
        <Folder class="size-3.5 shrink-0 text-muted-foreground" />
      {/if}
    {:else}
      <span class="size-3 shrink-0"></span>
      <FileTypeIcon filename={entry.name} size={14} />
    {/if}
    <span class="truncate">{entry.name}</span>
    {#if status}
      <span
        class="ml-auto pl-1 text-xs font-semibold leading-none tabular-nums"
        style:color={statusColor(status)}
        aria-label={statusAria(status)}
      >
        {statusLabel(status)}
      </span>
    {/if}
  </button>

  {#if entry.isDir && isOpen}
    <!-- The row's aria-expanded has to point at something: this is the group it
         opens, owned by the button above through aria-owns because a treeitem
         that is a <button> cannot contain the rows nested under it. -->
    <div id={groupId} role="group">
      {#if isLoading && !children}
        <div
          class="px-1 py-0.5 text-sm text-muted-2"
          style:padding-left="{depth * 12 + 24}px"
        >
          {t("common.loading")}
        </div>
      {:else if errMsg}
        <div
          class="px-1 py-0.5 text-sm text-[var(--color-danger)]"
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
            class="px-1 py-0.5 text-sm text-muted-2 italic"
            style:padding-left="{depth * 12 + 24}px"
          >
            {t("explorer.empty")}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
{/if}
