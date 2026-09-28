<script lang="ts">
  // The files one finished answer made or changed, at its end. A row opens the
  // file in the side panel, which already reads text, shows pictures and offers
  // a download for the rest. "Show in folder" hands the path to the system file
  // manager, only in the shell on its own core, and never opens the file itself.
  import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff, FilePenLine, FilePlus2, FileMinus2, Folder, FolderOpen, GitCompareArrows } from '@lucide/svelte';
  import { revealFile } from '../lib/links';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { turnFileTree, type TurnDiff, type TurnFile, type TurnFileNode } from '../lib/turn-files';
  import DiffView from './DiffView.svelte';

  /**
   * `diffs` is what the answer's own calls changed, shown here on demand. What
   * the whole thread changed is the working tree against its last commit: the
   * Changes panel, one click away for whoever can read the repository.
   */
  let { store, files, diffs = [] }: { store: Store; files: TurnFile[]; diffs?: TurnDiff[] } = $props();
  let showDiff = $state(false);
  let repository = $derived(store.owner && store.openProject?.repository === true);
  let tree = $derived(turnFileTree(files));
  let expanded = $state<Record<string, boolean>>({});
  let allExpanded = $state(false);
  let hasFolders = $derived(tree.some((node) => node.kind === 'folder'));

  function toggleAll(): void {
    allExpanded = !allExpanded;
    expanded = {};
  }

  const CHANGE_LABEL = {
    created: () => strings.chat.fileCreated,
    changed: () => strings.chat.fileChanged,
    deleted: () => strings.chat.fileDeleted
  } satisfies Record<TurnFile['change'], () => string>;

  /** A paired device cannot read files, so its rows stay plain text instead of opening a refusal. */
  function openable(file: TurnFile): boolean {
    return store.owner && file.relative !== null && file.change !== 'deleted';
  }

  async function reveal(file: TurnFile): Promise<void> {
    if (file.absolute === null) return;
    try {
      await revealFile(file.absolute);
    } catch (error) {
      store.error = fill(strings.chat.revealFailed, { reason: error instanceof Error ? error.message : String(error) });
    }
  }
</script>

<section class="turn-files" data-testid="turn-files" aria-label={strings.chat.turnFiles}>
  <header>
    <span>{strings.chat.turnFiles}</span>
    <span class="count">{files.length}</span>
    {#if hasFolders}
      <button type="button" class="ghost small icon expand" data-testid="turn-files-expand"
        title={allExpanded ? strings.chat.collapseFileFolders : strings.chat.expandFileFolders}
        aria-label={allExpanded ? strings.chat.collapseFileFolders : strings.chat.expandFileFolders}
        onclick={toggleAll}>
        {#if allExpanded}<ChevronsDownUp size={14} />{:else}<ChevronsUpDown size={14} />{/if}
      </button>
    {/if}
    <span class="tools">
      {#if diffs.length > 0}
        <button type="button" class="ghost small" data-testid="turn-diff-toggle" aria-expanded={showDiff} onclick={() => (showDiff = !showDiff)}>
          <FileDiff size={14} />{showDiff ? strings.chat.hideTurnDiff : strings.chat.showTurnDiff}
        </button>
      {/if}
      {#if repository}
        <button type="button" class="ghost small icon" data-testid="turn-all-changes" title={strings.chat.allChanges} aria-label={strings.chat.allChanges}
          onclick={() => store.panel.openChanges()}><GitCompareArrows size={14} /></button>
      {/if}
    </span>
  </header>
  <div class="tree">{@render branch(tree, 0)}</div>
  {#if showDiff}
    <div class="diffs" data-testid="turn-diff">
      {#each diffs as doc, index (index)}
        <DiffView path={doc.path} oldText={doc.oldText} newText={doc.newText} />
      {/each}
    </div>
  {/if}
</section>

{#snippet fileIcon(file: TurnFile)}
  <span class="file-icon" data-testid="turn-file-change" title={CHANGE_LABEL[file.change]()}>
    {#if file.change === 'created'}<FilePlus2 size={14} strokeWidth={1.75} />
    {:else if file.change === 'deleted'}<FileMinus2 size={14} strokeWidth={1.75} />
    {:else}<FilePenLine size={14} strokeWidth={1.75} />{/if}
    <span class="visually-hidden">{CHANGE_LABEL[file.change]()}</span>
  </span>
{/snippet}

{#snippet branch(nodes: TurnFileNode[], depth: number)}
  <ul>
    {#each nodes as node (node.key)}
      {#if node.kind === 'folder'}
        {@const open = expanded[node.key] ?? allExpanded}
        <li>
          <button type="button" class="folder-row" data-testid="turn-file-folder" aria-expanded={open}
            style:--depth={depth} title={node.name}
            onclick={() => expanded[node.key] = !open}>
            <ChevronRight size={14} class={open ? 'chevron expanded' : 'chevron'} />
            {#if open}<FolderOpen size={14} strokeWidth={1.75} />{:else}<Folder size={14} strokeWidth={1.75} />{/if}
            <span class="folder">{node.name}</span>
            <span class="count">{node.count}</span>
          </button>
          {#if open}{@render branch(node.children, depth + 1)}{/if}
        </li>
      {:else}
      {@const file = node.file}
      <li class="row" data-change={file.change} style:--depth={depth} title={file.path}>
        {#if openable(file)}
          <button
            type="button"
            class="open"
            data-testid="turn-file"
            aria-label={`${fill(strings.chat.openFile, { name: file.name })}, ${CHANGE_LABEL[file.change]()}`}
            onclick={() => store.panel.openFile(file.relative!)}
          >
            {@render fileIcon(file)}
            <span class="name">{file.name}</span>
          </button>
        {:else}
          <span class="open" data-testid="turn-file">
            {@render fileIcon(file)}
            <span class="name">{file.name}</span>
          </span>
        {/if}
        {#if store.pickerAvailable && file.absolute !== null && file.change !== 'deleted'}
          <button
            type="button"
            class="ghost small icon reveal"
            data-testid="turn-file-reveal"
            title={strings.chat.revealFile}
            aria-label={strings.chat.revealFile}
            onclick={() => void reveal(file)}
          >
            <FolderOpen size={14} strokeWidth={1.75} />
          </button>
        {/if}
      </li>
      {/if}
    {/each}
  </ul>
{/snippet}

<style>
  .turn-files {
    display: flex;
    flex-direction: column;
    /* The answer's parts sit 4px in; the card lines up with them. */
    margin: 12px 0 0 4px;
    background: var(--color-surface);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--row);
    padding: 6px 12px;
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .count {
    flex: none;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    font-weight: 400;
  }
  .expand, .tools { margin-left: auto; }
  .expand ~ .tools { margin-left: 0; }
  .tools { display: flex; align-items: center; gap: 2px; }
  .tools button:not(.icon) { display: inline-flex; align-items: center; gap: 6px; }
  .tree { padding: 0 6px 6px; }
  .diffs { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--control);
    padding-left: calc(8px + var(--depth) * 14px + 22px);
    border-radius: var(--radius-sm);
  }

  .row:hover { background: var(--color-hover); }

  .open {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: auto;
    min-height: var(--control);
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    justify-content: flex-start;
    text-align: left;
  }

  /* The row carries the hover, so the button inside it stays flat. */
  button.open:hover:not(:disabled) { background: none; }
  button.open:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
  .file-icon { display: flex; flex: none; color: var(--color-muted-foreground); }

  .name {
    font-size: var(--text-xs);
    font-weight: 400;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder {
    flex: 1;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    min-height: var(--control);
    height: auto;
    padding: 4px 8px 4px calc(8px + var(--depth) * 14px);
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    text-align: left;
    font-weight: 400;
    color: var(--color-muted-foreground);
  }
  .folder-row :global(svg) { flex: none; }
  .folder-row :global(.chevron) { transition: transform var(--dur-2); }
  .folder-row :global(.expanded) { transform: rotate(90deg); }
  .folder-row:hover { background: var(--color-hover); }
  .folder-row:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }

  [data-change='deleted'] .name { text-decoration: line-through; color: var(--color-muted-foreground); }

  [data-change='created'] .file-icon { color: var(--color-success); }
  [data-change='deleted'] .file-icon { color: var(--color-danger); }

  .reveal { flex: none; opacity: 0; }
  .row:hover .reveal, .row:focus-within .reveal { opacity: 1; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (pointer: coarse), (max-width: 720px) {
    .folder-row, .row, .open { min-height: var(--touch-target); }
    .reveal { opacity: 1; }
  }
</style>
