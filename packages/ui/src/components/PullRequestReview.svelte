<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ArrowLeft, ExternalLink, RefreshCw } from '@lucide/svelte';
  import type { PullRequestReview, PullRequestFiles, PullRequestFile, PullRequestComment } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings, fill } from '../lib/strings';
  import { renderMarkdown } from '../lib/markdown';
  let { store, threadId, url, onback }: { store: Store; threadId: string; url: string; onback: () => void } = $props();
  const client = untrack(() => store.client);
  let review = $state<PullRequestReview | null>(null), files = $state<PullRequestFile[]>([]), page = $state(0), hasMore = $state(false), shortened = $state(false);
  let tab = $state<'overview' | 'files' | 'comments' | 'checks'>('overview'), busy = $state(false), error = $state(''), alive = true;
  let expanded = $state<string[]>([]);
  function applyFiles(result: PullRequestFiles, reset: boolean) {
    files = reset ? result.files : [...files, ...result.files]; page = result.page; hasMore = result.hasMore; shortened = (reset ? false : shortened) || result.truncated;
  }
  async function load() {
    if (!client || busy) return;
    busy = true; error = '';
    try {
      const [r, f] = await Promise.all([client.call('threads.pullRequestReview', { threadId, url }), client.call('threads.pullRequestFiles', { threadId, url, page: 1 })]);
      if (alive) { review = r; applyFiles(f, true); }
    } catch (cause) { if (alive) error = String(cause); }
    finally { if (alive) busy = false; }
  }
  async function more() {
    if (!client || busy || !hasMore) return;
    busy = true; error = '';
    try { const result = await client.call('threads.pullRequestFiles', { threadId, url, page: page + 1 }); if (alive) applyFiles(result, false); }
    catch (cause) { if (alive) error = String(cause); }
    finally { if (alive) busy = false; }
  }
  onMount(() => { void load(); return () => { alive = false; }; });
  function toggle(path: string) { expanded = expanded.includes(path) ? expanded.filter(p => p !== path) : [...expanded, path]; }
</script>

<section class="review" data-testid="pr-review">
  <div class="actions"><button type="button" class="chip" onclick={onback}><ArrowLeft size={16} /><span class="ui-label">{strings.prReview.back}</span></button><button type="button" class="chip" disabled={busy} aria-label={strings.prReview.refresh} onclick={() => void load()}><RefreshCw size={16} /></button><a class="chip" href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />{strings.prReview.github}</a></div>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if busy}<p role="status">{strings.prReview.loading}</p>{/if}
  {#if review}
    <h3>{review.title}</h3><p class="branches">{review.head} → {review.base} · {review.state}</p>
    <nav aria-label={strings.prReview.open}>{#each (['overview', 'files', 'comments', 'checks'] as const) as choice}<button type="button" class="chip" class:active={tab === choice} aria-pressed={tab === choice} onclick={() => { tab = choice; }} data-testid={`pr-review-${choice}`}><span class="ui-label">{strings.prReview[choice]}</span>{#if choice === 'files'} <span class="ui-label">{files.length}{hasMore ? '+' : ''}</span>{:else if choice === 'checks'} <span class="ui-label">{review.checks.length}</span>{:else if choice === 'comments'} <span class="ui-label">{review.comments.length + review.reviews.length}</span>{/if}</button>{/each}</nav>
    {#if review.truncated || shortened}<p class="notice" role="status">{strings.prReview.truncated}</p>{/if}
    {#if tab === 'overview'}<div class="prose">{@html renderMarkdown(review.body || strings.prReview.empty)}</div>
    {:else if tab === 'checks'}
      {#if !review.checks.length}<p class="muted">{strings.prReview.empty}</p>{/if}
      <ul class="checks">{#each review.checks as check}<li><div><strong>{check.name}</strong><span class:failed={['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(check.state)} class:passed={check.state === 'SUCCESS'}>{check.state}</span></div>{#if check.url}<a href={check.url} target="_blank" rel="noopener noreferrer">{strings.prReview.github}</a>{/if}</li>{/each}</ul>
    {:else if tab === 'comments'}
      {#each [...review.reviews, ...review.comments].sort((a, b) => a.at.localeCompare(b.at)) as comment}{@render discussion(comment)}{/each}
      {#if !review.comments.length && !review.reviews.length}<p class="muted">{strings.prReview.empty}</p>{/if}
    {:else}
      <p class="muted">{fill(strings.prReview.fileCount, { count: String(files.length) })}</p>
      {#each files as file (file.path)}
        <article class="file"><button type="button" class="file-head" aria-expanded={expanded.includes(file.path)} onclick={() => toggle(file.path)}><span>{file.path}{#if file.previousPath}<small>← {file.previousPath}</small>{/if}</span><span class="counts"><b class="passed">+{file.additions}</b> <b class="failed">−{file.deletions}</b></span></button>
          {#if expanded.includes(file.path)}
            {#if file.patch !== null}<div class="patch" role="region" aria-label={file.path}><pre>{#each file.patch.split('\n') as line}<span class:add={line.startsWith('+')} class:remove={line.startsWith('-')} class:hunk={line.startsWith('@@')}>{line || ' '}</span>{/each}</pre></div>{:else}<p class="muted">{strings.prReview.unavailable}</p>{/if}
          {/if}
        </article>
      {/each}
      {#if hasMore}<button type="button" class="chip" disabled={busy} onclick={() => void more()}><span class="ui-label">{strings.prReview.more}</span></button>{/if}
    {/if}
  {/if}
</section>

{#snippet discussion(comment: PullRequestComment)}
  <article class="comment"><header><strong>{comment.author}</strong><small>{comment.at ? new Date(comment.at).toLocaleString() : ''}</small>{#if comment.state}<span>{comment.state}</span>{/if}</header>{#if comment.path}<p class="path">{comment.path}{comment.line ? `:${comment.line}` : ''}</p>{/if}<div class="prose">{@html renderMarkdown(comment.body)}</div>{#if comment.url}<a href={comment.url} target="_blank" rel="noopener noreferrer">{strings.prReview.github}</a>{/if}</article>
{/snippet}

<style>
  .review { min-width: 0; } .actions, nav { display: flex; gap: 8px; flex-wrap: wrap; } .chip { min-height: 44px; min-width: 44px; text-decoration: none; } a { color: var(--color-accent); } h3 { font-size: var(--text-lg); margin: 20px 0 8px; overflow-wrap: anywhere; } .branches, .muted, small { color: var(--color-muted-foreground); font-size: var(--text-sm); } .branches { overflow-wrap: anywhere; } nav { padding: 10px 0; position: sticky; top: -16px; background: var(--color-surface); z-index: 1; } .active { background: var(--color-accent-soft); color: var(--color-accent); }
  .prose { overflow-wrap: anywhere; font-size: var(--text-sm); line-height: 1.6; } .notice { padding: 10px; background: var(--color-surface-2); font-size: var(--text-sm); } .error, .failed { color: var(--color-danger); } .passed { color: var(--color-success); } .checks { list-style: none; padding: 0; } .checks li { padding: 12px 0; border-bottom: 1px solid var(--color-border); font-size: var(--text-sm); overflow-wrap: anywhere; } .checks li div { display: flex; gap: 12px; justify-content: space-between; flex-wrap: wrap; } .checks a, .comment a { display: inline-flex; align-items: center; min-height: 44px; font-size: var(--text-sm); }
  .file { margin: 10px 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow: hidden; } .file-head { display: flex; white-space: normal; align-items: flex-start; gap: 10px; justify-content: space-between; width: 100%; text-align: left; min-height: 48px; padding: 12px; border: 0; background: var(--color-surface-2); color: var(--color-foreground); font-size: var(--text-sm); } .file-head > span:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; } .file-head small { display: block; } .counts { white-space: nowrap; flex: none; } .patch { overflow-x: auto; max-height: 60dvh; } pre { font-family: var(--font-mono); font-size: 12px; line-height: 1.6; margin: 0; width: max-content; min-width: 100%; padding: 8px 0; } pre span { display: block; padding: 0 12px; } .add { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 14%, var(--color-surface-2)); } .remove { color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 14%, var(--color-surface-2)); } .hunk { color: var(--color-accent); background: var(--color-accent-soft); } .comment { margin: 12px 0; padding: 12px; background: var(--color-surface-2); border-radius: var(--radius-md); } .comment header { display: flex; gap: 8px; flex-wrap: wrap; font-size: var(--text-sm); margin-bottom: 8px; } .path { font-size: var(--text-sm); overflow-wrap: anywhere; }
</style>
