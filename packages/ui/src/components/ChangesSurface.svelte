<script lang="ts">
  import { ArrowDown, ArrowUp, GitBranch, RefreshCw } from '@lucide/svelte';
  import type { GitChange, GitDiff, GitStatus } from '@boite/contracts';
  import type { BoundPanel, Surface } from '../lib/right-panel.svelte';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import DiffView from './DiffView.svelte';

  let { store, surface, panel }: { store: Store; surface: Surface; panel: BoundPanel } = $props();

  let status = $state<GitStatus | null>(null);
  let diff = $state<GitDiff | null>(null);
  let loading = $state(false);

  let threadId = $derived(store.openThread?.id ?? null);
  let selected = $derived(surface.path ?? null);
  /** Every turn that ended, so the list is read again the moment the agent stops writing. */
  let finished = $derived(store.openThread?.turns.filter((turn) => turn.finishedAt !== null).length ?? 0);

  /** One letter per status, the one `git status --short` prints. */
  const LETTERS: Record<GitChange['status'], string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    untracked: 'U',
    conflict: '!'
  };

  function directory(path: string): string {
    const cut = path.lastIndexOf('/');
    return cut < 0 ? '' : path.slice(0, cut + 1);
  }

  function base(path: string): string {
    const cut = path.lastIndexOf('/');
    return cut < 0 ? path : path.slice(cut + 1);
  }

  async function refresh(): Promise<void> {
    const id = threadId;
    if (id === null) return;
    loading = true;
    try {
      const answer = await store.gitStatus(id);
      // The thread may have changed while the call was out: an answer about
      // another working tree must not land in this list.
      if (threadId === id) status = answer;
    } finally {
      loading = false;
    }
  }

  function select(change: GitChange): void {
    // The selection rides the tab, so it survives a switch to another surface.
    panel.update(surface.id, { path: change.path });
  }

  // On mount, and again on every turn that ends: the working tree is what the
  // agent is changing, so the list is stale the moment a turn finishes.
  $effect(() => {
    void threadId;
    void finished;
    void refresh();
  });

  // The diff of the selected row, read again when the status did.
  $effect(() => {
    const id = threadId;
    const path = selected;
    void status;
    if (id === null || path === null) {
      diff = null;
      return;
    }
    void store.gitDiff(id, path).then((answer) => {
      if (threadId === id && selected === path) diff = answer;
    });
  });
</script>

<div class="changes-surface" data-testid="changes-panel">
  <div class="bar">
    <span class="branch" title={status?.upstream ?? strings.changes.noBranch}>
      <GitBranch size={13} strokeWidth={1.75} />
      {status?.branch ?? strings.changes.noBranch}
    </span>
    {#if status && status.ahead > 0}
      <span class="track" title={fill(strings.changes.ahead, { count: String(status.ahead) })}>
        <ArrowUp size={13} strokeWidth={1.75} />{status.ahead}
      </span>
    {/if}
    {#if status && status.behind > 0}
      <span class="track" title={fill(strings.changes.behind, { count: String(status.behind) })}>
        <ArrowDown size={13} strokeWidth={1.75} />{status.behind}
      </span>
    {/if}
    <span class="spacer"></span>
    <span class="total" data-testid="changes-count">
      {status
        ? status.changes.length === 1
          ? strings.changes.oneCount
          : fill(strings.changes.count, { count: String(status.changes.length) })
        : strings.changes.loading}
    </span>
    <button
      type="button"
      class="ghost small icon"
      title={strings.common.refresh}
      aria-label={strings.common.refresh}
      data-testid="changes-refresh"
      disabled={loading}
      onclick={() => void refresh()}
    >
      <RefreshCw size={13} strokeWidth={1.75} />
    </button>
  </div>

  <div class="split">
    <div class="list" role="listbox" aria-label={strings.rightPanel.changes} tabindex="-1">
      {#if status && status.changes.length === 0}
        <p class="empty" data-testid="changes-empty">{strings.changes.clean}</p>
      {/if}
      {#each status?.changes ?? [] as change (change.path)}
        <button
          type="button"
          class="row"
          class:on={change.path === selected}
          role="option"
          aria-selected={change.path === selected}
          data-testid="changes-row"
          data-path={change.path}
          data-status={change.status}
          title={change.oldPath
            ? `${change.path}\n${fill(strings.changes.renamedFrom, { path: change.oldPath })}`
            : change.path}
          onclick={() => select(change)}
        >
          <span class="mark" data-status={change.status} title={strings.changes.status[change.status]}>
            {LETTERS[change.status]}
          </span>
          <span class="path">
            <span class="dir">{directory(change.path)}</span><span class="base">{base(change.path)}</span>
          </span>
          {#if change.staged}
            <span class="staged" title={strings.changes.staged}>{strings.changes.stagedShort}</span>
          {/if}
          {#if change.additions !== null && change.additions > 0}
            <span class="count added">+{change.additions}</span>
          {/if}
          {#if change.deletions !== null && change.deletions > 0}
            <span class="count removed">-{change.deletions}</span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="detail">
      {#if selected === null}
        <p class="empty">{strings.changes.pick}</p>
      {:else if diff === null}
        <p class="empty">{strings.changes.loading}</p>
      {:else if diff.binary}
        <p class="empty" data-testid="changes-binary">{strings.changes.binary}</p>
      {:else}
        {#if diff.truncated}
          <p class="notice" data-testid="changes-truncated">{strings.changes.truncated}</p>
        {/if}
        <DiffView path={diff.path} oldText={diff.oldText ?? ''} newText={diff.newText ?? ''} />
      {/if}
    </div>
  </div>
</div>

<style>
  .changes-surface {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    /* The split below asks this element's width, not the window's: the panel is
       dragged to any size and the query has to follow it. */
    container-type: inline-size;
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

  .branch,
  .track {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .branch {
    color: var(--color-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
    min-width: 4px;
  }

  .total {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .split {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .list {
    flex: none;
    max-height: 45%;
    overflow-y: auto;
    padding: 2px 6px 6px;
  }

  .detail {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 10px 10px;
  }

  /* Wide enough for two columns: the diff sits beside the list instead of under it. */
  @container (min-width: 900px) {
    .split {
      flex-direction: row;
    }

    .list {
      width: 320px;
      max-height: none;
      flex: none;
      border-right: 1px solid var(--color-border);
    }

    .detail {
      padding-top: 6px;
    }
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: var(--control-sm);
    padding: 0 6px;
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

  /* One badge, its colour set by the status; the fill is the same colour mixed
     into the ground, so neither theme ends up light on light. */
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex: none;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--mark) 18%, transparent);
    color: var(--mark);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .mark[data-status='added'],
  .mark[data-status='copied'] {
    --mark: var(--color-success);
  }

  .mark[data-status='modified'] {
    --mark: var(--color-live);
  }

  .mark[data-status='deleted'],
  .mark[data-status='conflict'] {
    --mark: var(--color-danger);
  }

  .mark[data-status='renamed'] {
    --mark: var(--color-accent);
  }

  .mark[data-status='untracked'] {
    --mark: var(--color-muted-foreground);
  }

  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }

  /* `direction: rtl` keeps the file name in view when the path is cut; each
     span reads left to right again so the text itself is not reversed. */
  .dir,
  .base {
    direction: ltr;
    unicode-bidi: embed;
  }

  .dir {
    color: var(--color-subtle);
  }

  .base {
    color: inherit;
  }

  .row.on .base {
    color: var(--color-foreground);
  }

  .staged {
    flex: none;
    padding: 0 5px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    line-height: 18px;
    font-weight: 600;
  }

  .count {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .count.added {
    color: var(--color-success);
  }

  .count.removed {
    color: var(--color-danger);
  }

  .empty {
    padding: 10px 6px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .notice {
    margin: 6px 0;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
</style>
