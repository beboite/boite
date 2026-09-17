<script lang="ts">
  // The working directory as a tree. One `files.list` per directory, on the
  // expand and never before: a repository with ten thousand files costs the
  // same as a small one until someone opens a folder.
  import { tick, untrack } from 'svelte';
  import {
    ChevronRight,
    File,
    FileAudio,
    FileImage,
    FileText,
    FileVideo,
    Folder,
    FolderOpen,
    FolderTree,
    RefreshCw
  } from '@lucide/svelte';
  import { FILES_LIST_MAX, type FileEntry } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store, surface, panel }: { store: Store; surface: Surface; panel: BoundPanel } = $props();

  /** One entry per directory already read, keyed by its path. The root is the empty key. */
  let loaded = $state<Record<string, FileEntry[]>>({});
  let expanded = $state<Record<string, boolean>>({});
  let reading = $state(0);
  /** What the last refused directory answered, shown in the surface rather than as a toast. */
  let problem = $state<string | null>(null);
  let filter = $state('');
  let cursor = $state(0);
  let list = $state<HTMLDivElement | undefined>(undefined);

  let threadId = $derived(store.openThread?.id ?? null);

  /** The name of the working directory itself, whichever separator the core wrote. */
  let rootName = $derived.by(() => {
    const cwd = store.openThread?.cwd ?? '';
    const parts = cwd.split(/[\\/]/).filter((part) => part !== '');
    return parts[parts.length - 1] ?? strings.files.noRoot;
  });

  /** A directory the core cut at its own limit: the footer says so once. */
  let capped = $derived(Object.values(loaded).some((entries) => entries.length >= FILES_LIST_MAX));

  interface Row {
    entry: FileEntry;
    depth: number;
  }

  const IMAGES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'];
  const VIDEOS = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'];
  const SOUNDS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
  const TEXTS = [
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'svelte', 'md', 'json', 'css', 'html', 'txt',
    'yml', 'yaml', 'toml', 'rs', 'py', 'sh', 'ps1', 'sql', 'lock', 'xml', 'svg'
  ];

  /** What a row draws for a file, from the only thing a listing carries: its name. */
  function kindOf(name: string): 'image' | 'video' | 'audio' | 'text' | 'other' {
    const dot = name.lastIndexOf('.');
    const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
    if (extension === 'svg') return 'image';
    if (IMAGES.includes(extension)) return 'image';
    if (VIDEOS.includes(extension)) return 'video';
    if (SOUNDS.includes(extension)) return 'audio';
    if (TEXTS.includes(extension)) return 'text';
    return 'other';
  }

  /** The loaded rows, narrowed by the filter. A directory stays for a match under it. */
  function collect(path: string, depth: number, word: string): Row[] {
    const out: Row[] = [];
    for (const entry of loaded[path] ?? []) {
      const children =
        entry.kind === 'dir' && expanded[entry.path] === true ? collect(entry.path, depth + 1, word) : [];
      const hit = word === '' || entry.name.toLowerCase().includes(word);
      if (!hit && children.length === 0) continue;
      out.push({ entry, depth });
      out.push(...children);
    }
    return out;
  }

  let rows = $derived(collect('', 0, filter.trim().toLowerCase()));

  async function read(path: string, again = false): Promise<void> {
    const id = threadId;
    if (id === null) return;
    if (!again && loaded[path] !== undefined) return;
    reading += 1;
    const answer = await store.listFiles(id, path === '' ? undefined : path);
    reading -= 1;
    // The thread may have changed while the call was out: another working
    // directory's answer must not land in this tree.
    if (threadId !== id) return;
    if (answer.ok) {
      loaded = { ...loaded, [path]: answer.value };
      problem = null;
    } else {
      problem = answer.error;
    }
  }

  /** The root, then every ancestor of the directory the tab was opened on. */
  async function openAt(path: string): Promise<void> {
    await read('');
    if (path === '') return;
    let at = '';
    for (const part of path.split('/').filter((one) => one !== '')) {
      at = at === '' ? part : `${at}/${part}`;
      expanded = { ...expanded, [at]: true };
      await read(at);
    }
    await tick();
    const node = list?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    // jsdom lays nothing out, so it scrolls nothing either.
    node?.scrollIntoView?.({ block: 'nearest' });
    const index = rows.findIndex((row) => row.entry.path === path);
    if (index >= 0) cursor = index;
  }

  function toggle(path: string): void {
    const on = expanded[path] === true;
    expanded = { ...expanded, [path]: !on };
    if (!on) void read(path);
  }

  function activate(row: Row | undefined): void {
    if (!row) return;
    if (row.entry.kind === 'dir') toggle(row.entry.path);
    else panel.openFile(row.entry.path);
  }

  function focusRow(index: number): void {
    const at = Math.max(0, Math.min(rows.length - 1, index));
    cursor = at;
    const nodes = list?.querySelectorAll<HTMLElement>('[data-testid="files-row"]');
    nodes?.[at]?.focus();
  }

  /** The arrows walk the tree, right opens a directory, left shuts it or climbs. */
  function onkeydown(event: KeyboardEvent): void {
    const row = rows[cursor];
    const key = event.key;
    if (key === 'ArrowDown') {
      event.preventDefault();
      focusRow(cursor + 1);
    } else if (key === 'ArrowUp') {
      event.preventDefault();
      focusRow(cursor - 1);
    } else if (key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (key === 'End') {
      event.preventDefault();
      focusRow(rows.length - 1);
    } else if (key === 'ArrowRight') {
      if (!row) return;
      event.preventDefault();
      if (row.entry.kind !== 'dir') return;
      if (expanded[row.entry.path] === true) focusRow(cursor + 1);
      else toggle(row.entry.path);
    } else if (key === 'ArrowLeft') {
      if (!row) return;
      event.preventDefault();
      if (row.entry.kind === 'dir' && expanded[row.entry.path] === true) {
        toggle(row.entry.path);
        return;
      }
      for (let at = cursor - 1; at >= 0; at--) {
        if ((rows[at]?.depth ?? 0) < row.depth) {
          focusRow(at);
          return;
        }
      }
    } else if (key === 'Enter') {
      event.preventDefault();
      activate(row);
    }
  }

  function refresh(): void {
    for (const path of Object.keys(loaded)) void read(path, true);
  }

  // On mount, and again whenever the tab is asked for another directory: the
  // path it carries is what the tree opens on and scrolls to.
  $effect(() => {
    const id = threadId;
    const wanted = surface.path ?? '';
    if (id === null) return;
    untrack(() => void openAt(wanted));
  });
</script>

<div class="files-surface" data-testid="files-panel" data-path={surface.path ?? ''}>
  <div class="bar">
    <span class="root" title={store.openThread?.cwd ?? ''} data-testid="files-root">
      <FolderTree size={13} strokeWidth={1.75} />
      {rootName}
    </span>
    <span class="spacer"></span>
    <input
      class="filter"
      bind:value={filter}
      placeholder={strings.files.filter}
      title={strings.files.filterHint}
      aria-label={strings.files.filterHint}
      data-testid="files-filter"
    />
    <button
      type="button"
      class="ghost small icon"
      title={strings.common.refresh}
      aria-label={strings.common.refresh}
      data-testid="files-refresh"
      disabled={reading > 0}
      onclick={refresh}
    >
      <RefreshCw size={13} strokeWidth={1.75} />
    </button>
  </div>

  {#if problem !== null}
    <p class="notice" data-testid="files-error">{fill(strings.files.failed, { reason: problem })}</p>
  {/if}

  <div
    class="tree"
    role="tree"
    tabindex="-1"
    aria-label={strings.files.tree}
    bind:this={list}
    {onkeydown}
  >
    {#each rows as row, index (row.entry.path)}
      <button
        type="button"
        class="row"
        class:on={index === cursor}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={index === cursor}
        aria-expanded={row.entry.kind === 'dir' ? expanded[row.entry.path] === true : undefined}
        tabindex={index === cursor ? 0 : -1}
        style="--depth: {row.depth}"
        data-testid="files-row"
        data-path={row.entry.path}
        data-kind={row.entry.kind}
        data-depth={row.depth}
        title={row.entry.path}
        onclick={() => {
          cursor = index;
          activate(row);
        }}
        onfocus={() => (cursor = index)}
      >
        <span class="chev" data-open={row.entry.kind === 'dir' ? expanded[row.entry.path] === true : null}>
          {#if row.entry.kind === 'dir'}
            <ChevronRight size={12} strokeWidth={2} />
          {/if}
        </span>
        <span class="glyph" data-file-kind={row.entry.kind === 'dir' ? 'dir' : kindOf(row.entry.name)}>
          {#if row.entry.kind === 'dir'}
            {#if expanded[row.entry.path] === true}
              <FolderOpen size={13} strokeWidth={1.75} />
            {:else}
              <Folder size={13} strokeWidth={1.75} />
            {/if}
          {:else if kindOf(row.entry.name) === 'image'}
            <FileImage size={13} strokeWidth={1.75} />
          {:else if kindOf(row.entry.name) === 'video'}
            <FileVideo size={13} strokeWidth={1.75} />
          {:else if kindOf(row.entry.name) === 'audio'}
            <FileAudio size={13} strokeWidth={1.75} />
          {:else if kindOf(row.entry.name) === 'text'}
            <FileText size={13} strokeWidth={1.75} />
          {:else}
            <File size={13} strokeWidth={1.75} />
          {/if}
        </span>
        <span class="name">{row.entry.name}</span>
        {#if row.entry.kind === 'file'}
          <span class="size" data-testid="files-size">{bytes(row.entry.bytes)}</span>
        {/if}
      </button>
    {/each}

    {#if rows.length === 0 && problem === null}
      <p class="empty" data-testid="files-empty">
        {filter.trim() === '' ? strings.files.empty : strings.files.noMatch}
      </p>
    {/if}
  </div>

  {#if capped}
    <p class="footer" data-testid="files-capped">
      {fill(strings.files.capped, { count: String(FILES_LIST_MAX) })}
    </p>
  {/if}
</div>

<style>
  .files-surface {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--row);
    padding: 0 6px 0 12px;
    flex: none;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .root {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    flex: none;
    color: var(--color-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
    min-width: 4px;
  }

  .filter {
    width: 110px;
    min-width: 60px;
    flex: 0 1 auto;
    height: var(--control-sm);
    padding: 0 8px;
    font-size: var(--text-xs);
  }

  .tree {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 2px 6px 8px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    height: var(--control-sm);
    /* The depth is an indent, not a nested box: every row scrolls as one line. */
    padding: 0 6px 0 calc(6px + var(--depth) * 12px);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    font-weight: 400;
    text-align: left;
  }

  .row:hover:not(:disabled) {
    background: var(--color-hover);
  }

  .row:active:not(:disabled) {
    transform: none;
  }

  .row.on {
    background: var(--color-active);
    color: var(--color-foreground);
  }

  .chev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    flex: none;
    color: var(--color-subtle);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .chev[data-open='true'] {
    transform: rotate(90deg);
  }

  .glyph {
    display: inline-flex;
    flex: none;
    color: var(--color-subtle);
  }

  .glyph[data-file-kind='dir'] {
    color: var(--color-accent);
  }

  .glyph[data-file-kind='image'],
  .glyph[data-file-kind='video'],
  .glyph[data-file-kind='audio'] {
    color: var(--color-muted-foreground);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.on .name {
    color: var(--color-foreground);
  }

  .size {
    flex: none;
    color: var(--color-subtle);
    font-variant-numeric: tabular-nums;
  }

  .empty,
  .notice,
  .footer {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .empty {
    padding: 10px 6px;
  }

  .notice {
    padding: 4px 12px 6px;
    color: var(--color-danger);
  }

  .footer {
    flex: none;
    padding: 6px 12px 8px;
    border-top: 1px solid var(--color-border);
  }
</style>
