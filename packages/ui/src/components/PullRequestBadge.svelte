<script lang="ts">
  import { GitMerge, GitPullRequest, GitPullRequestClosed } from '@lucide/svelte';
  import type { ThreadSummary } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  let { pullRequest }: { pullRequest: NonNullable<ThreadSummary['pullRequest']> } = $props();
  const label = $derived(fill(pullRequest.state === 'MERGED' ? strings.sidebar.prMerged : pullRequest.state === 'CLOSED' ? strings.sidebar.prClosed : strings.sidebar.prOpen, { number: String(pullRequest.number) }));
</script>

<a class="pr-link {pullRequest.state.toLowerCase()}" data-testid="thread-pr" data-state={pullRequest.state} href={pullRequest.url} target="_blank" rel="noopener noreferrer" title={`${label}\n${pullRequest.url}`} aria-label={label}>
  {#if pullRequest.state === 'MERGED'}<GitMerge size={12} />{:else if pullRequest.state === 'CLOSED'}<GitPullRequestClosed size={12} />{:else}<GitPullRequest size={12} />{/if}<span class="ui-label">#{pullRequest.number}</span>
</a>

<style>
  .pr-link { display: inline-flex; align-items: center; flex-shrink: 0; gap: 4px; color: var(--color-live); font-size: var(--text-xs); pointer-events: auto; text-decoration: underline; text-underline-offset: 3px; }
  .pr-link.merged { color: var(--color-accent); }
  .pr-link.closed { color: var(--color-danger); }
  .pr-link:hover { text-decoration: underline; }
</style>
