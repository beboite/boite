<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { GitPullRequest, X, RefreshCw, Unlink } from '@lucide/svelte';
  import { pullRequestParent, type LinkedPullRequest } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings, fill } from '../lib/strings';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  import { RpcFailure } from '../lib/client';
  import { experimentOn } from '../lib/experiments.svelte';
  import PullRequestReview from './PullRequestReview.svelte';
  let { store, threadId }: { store: Store; threadId: string } = $props();
  let prs = $state<LinkedPullRequest[]>([]), shown = $state(false), supported = $state(true), busy = $state(false), error = $state(''), url = $state('');
  let dialog = $state<HTMLDialogElement>();
  let reviewUrl = $state<string | null>(null);
  $effect(() => { if (!experimentOn('pr-review') || !shown) reviewUrl = null; });
  let alive = true;
  const client = untrack(() => store.client);
  async function refresh(force = false) {
    if (!client || client.state !== 'ready' || busy) return;
    busy = true;
    try { const result = await client.call('threads.pullRequests', { threadId, refresh: force }); if (alive) { prs = result; error = ''; } }
    catch (cause) { if (alive) { if (cause instanceof RpcFailure && cause.code === -32601) supported = false; else error = String(cause); } }
    finally { if (alive) busy = false; }
  }
  onMount(() => {
    const off = client?.on('threads.pullRequestsChanged', event => { if (event.threadId === threadId) prs = event.pullRequests; });
    const timer = setInterval(() => { if (!document.hidden && supported) void refresh(); }, 60_000);
    return () => { alive = false; off?.(); clearInterval(timer); };
  });
  $effect(() => { if (store.connection === 'ready') untrack(() => void refresh()); });
  $effect(() => {
    if (!shown || !dialog) return;
    const node = dialog, previous = focusedElement(); node.showModal();
    const release = mobileOverlay(() => { shown = false; });
    return () => { release(); node.close(); restoreFocus(previous); };
  });
  async function change(method: 'threads.linkPullRequest' | 'threads.unlinkPullRequest', value: string) {
    if (!client || busy) return;
    busy = true; error = '';
    try { const result = await client.call(method, { threadId, url: value }); if (alive) { prs = result; if (method === 'threads.linkPullRequest') url = ''; } }
    catch (cause) { if (alive) error = String(cause); }
    finally { if (alive) busy = false; }
  }
</script>

{#if supported}
  <button type="button" class="ghost small icon pr-toggle" data-testid="thread-prs" title={strings.pullRequests.title} aria-label={strings.pullRequests.title} onclick={() => { shown = true; }}>
    <GitPullRequest size={15} />{#if prs.length}<span class="ui-label">{prs.length}</span>{/if}
  </button>
{/if}
{#if shown}
  <dialog bind:this={dialog} data-testid="thread-prs-dialog" aria-label={strings.pullRequests.title} onkeydown={event => event.stopPropagation()} oncancel={event => { event.preventDefault(); shown = false; }}>
    <header><h2>{strings.pullRequests.title}</h2><button type="button" class="ghost small icon" aria-label={strings.imports.close} onclick={() => { shown = false; }}><X size={16} /></button></header>
    <div class="body">
      {#if reviewUrl && experimentOn('pr-review')}
        {#key reviewUrl}<PullRequestReview {store} {threadId} url={reviewUrl} onback={() => { reviewUrl = null; }} />{/key}
      {:else}
      <p class="muted">{strings.pullRequests.hint}</p>
      <button type="button" class="chip" disabled={busy} data-testid="thread-prs-refresh" onclick={() => void refresh(true)}><RefreshCw size={14} /><span class="ui-label">{strings.pullRequests.refresh}</span></button>
      {#if error}<p role="alert">{error}</p>{/if}
      {#if !prs.length}<p class="muted">{strings.pullRequests.empty}</p>{/if}
      <ol>{#each prs as pr (pr.url)}
        {@const parent = pullRequestParent(pr, prs)}
        <li data-testid="linked-pr" data-number={pr.number}>
          <div class="pr-line"><a href={pr.url} target="_blank" rel="noopener noreferrer">#{pr.number} {pr.title}</a>
            <span class="status" class:merged={pr.state === 'MERGED'} class:closed={pr.state === 'CLOSED'}>{pr.draft && pr.state === 'OPEN' ? strings.pullRequests.draft : strings.pullRequests[pr.state]}</span>
            {#if store.owner}<button type="button" class="ghost small icon" disabled={busy} aria-label={fill(strings.pullRequests.unlink, { number: String(pr.number) })} onclick={() => void change('threads.unlinkPullRequest', pr.url)}><Unlink size={14} /></button>{/if}</div>
          <small>{pr.repository} · {pr.head} → {pr.base}</small>
          {#if experimentOn('pr-review')}<button type="button" class="chip read-review" data-testid="pr-read" onclick={() => { reviewUrl = pr.url; }}><span class="ui-label">{strings.prReview.open}</span></button>{/if}
          {#if parent}<p class="dependency">{fill(strings.pullRequests.dependsOn, { number: String(parent.number) })}</p>{/if}
          {#if pr.error}<p class="stale" role="status">{strings.pullRequests.stale} {pr.error}</p>{/if}
        </li>
      {/each}</ol>
      {#if store.owner}<form onsubmit={event => { event.preventDefault(); void change('threads.linkPullRequest', url); }}>
        <label for="pr-url">{strings.pullRequests.url}</label>
        <div class="add"><input id="pr-url" type="url" required bind:value={url} placeholder="https://github.com/owner/repo/pull/123" data-testid="thread-pr-url" /><button type="submit" class="chip" disabled={busy || !url.trim()} data-testid="thread-pr-link"><span class="ui-label">{strings.pullRequests.link}</span></button></div>
      </form>{/if}
      {/if}
    </div>
  </dialog>
{/if}

<style>
  .pr-toggle { display: flex; gap: 4px; width: auto; min-width: var(--control); padding: 0 6px; flex: none; }
  .read-review { display: flex; margin-top: 8px; min-height: 44px; }
  dialog { width: min(720px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); margin: auto; padding: 0; color: var(--color-foreground); background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); box-shadow: var(--shadow-e3); }
  dialog[open] { display: flex; flex-direction: column; } dialog::backdrop { background: var(--color-scrim); }
  header { display: flex; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--color-border); } h2 { flex: 1; margin: 0; font-size: var(--text-md); }
  .body { overflow: auto; padding: 16px 18px; min-height: 0; } .muted, small { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  ol { list-style: none; padding: 0; } li { padding: 12px 0; border-bottom: 1px solid var(--color-border); overflow-wrap: anywhere; }
  .pr-line { display: flex; align-items: flex-start; gap: 8px; } a { flex: 1; min-width: 0; color: var(--color-accent); }
  .status { font-size: var(--text-xs); border-radius: var(--radius-sm); padding: 3px 6px; background: var(--color-accent-soft); flex: none; } .closed, .stale { color: var(--color-danger); } .merged { color: var(--color-accent); }
  .dependency { margin: 6px 0 0; font-size: var(--text-sm); } .stale { font-size: var(--text-sm); }
  form { margin-top: 18px; } label { display: block; font-size: var(--text-sm); margin-bottom: 8px; } .add { display: flex; gap: 8px; } input { flex: 1; min-width: 0; }
  @media (max-width: 480px) { .pr-line { flex-wrap: wrap; } .pr-line a { flex-basis: 100%; } .add { flex-wrap: wrap; } input { flex-basis: 100%; } }
</style>
