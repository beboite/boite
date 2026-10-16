<script lang="ts">
  import { FolderMinus } from '@lucide/svelte';
  import type { ThreadWorktreeRemoval } from '@boite/contracts';
  import { exactTime, relativeTime } from '../lib/format';
  import { fill, strings } from '../lib/strings';

  /*
   * Above the composer, or the done notice, of a thread whose worktree Boite
   * removed once its work was settled. The thread still names the folder; the
   * core refuses a turn there. This says so before anyone types, and what
   * became of the branch.
   */
  let { removal, archived }: { removal: ThreadWorktreeRemoval; archived: boolean } = $props();
  const t = $derived(strings.sidebar.worktreeGone);
  const when = $derived(relativeTime(removal.removedAt));
  const why = $derived(removal.reason === 'pr-merged' && removal.pullRequest
    ? fill(t.merged, { when, number: String(removal.pullRequest.number) })
    : fill(t.clean, { when }));
  const branch = $derived(removal.branch === null ? '' : fill(removal.branchDeleted ? t.branchDeleted : t.branchKept, { branch: removal.branch }));
</script>

<article class="worktree-gone" data-testid="worktree-gone" role="status">
  <span class="mark"><FolderMinus size={16} aria-hidden="true" /></span>
  <div class="text">
    <strong title={exactTime(removal.removedAt)}>{t.title}</strong>
    <p>
      {#if removal.pullRequest}
        <a href={removal.pullRequest.url} target="_blank" rel="noopener noreferrer">{why}</a>
      {:else}
        {why}
      {/if}
      {branch} {archived ? t.archived : t.live}
    </p>
  </div>
</article>

<style>
  .worktree-gone {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    /* The composer's own column, like the notice of a project folder that is gone. */
    flex: none;
    box-sizing: border-box;
    width: min(calc(100% - 40px), var(--content));
    margin: 0 auto 8px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
  }
  .mark { display: flex; flex: none; padding-top: 2px; color: var(--color-muted-foreground); }
  .text { flex: 1 1 240px; min-width: 0; }
  p { margin: 2px 0 0; color: var(--color-muted-foreground); line-height: 1.5; overflow-wrap: anywhere; }
  a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
  a:hover { color: var(--color-foreground); }
  @media (max-width: 720px) { .worktree-gone { width: calc(100% - 20px); } }
</style>
