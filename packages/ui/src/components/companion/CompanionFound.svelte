<!--
  What a search of the user's threads found (`[[find: …]]`): the threads that
  hold the words, the best first, each with its project, its date and the
  words around the match. A click opens one in Boite. It takes clicks
  (`data-hit`).
-->
<script lang="ts">
  import { LoaderCircle, Search, X } from '@lucide/svelte';
  import { ago } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';
  import type { Finder } from '../../lib/companion/watch.svelte';
  import type { Match } from '../../lib/companion/watch';

  interface Props {
    finder: Finder;
    onopen: (threadId: string) => void;
  }

  let { finder, onopen }: Props = $props();

  const copy = strings.companion.find;
  const found = $derived(finder.found ?? []);
  const heading = $derived(
    fill(finder.searching ? copy.searching : found.length === 0 ? copy.none : finder.complete ? copy.found : copy.closest, { query: finder.query })
  );
  const metaOf = ({ thread, project }: Match) => [project, ago(thread.updatedAt), thread.archived ? copy.archived : ''].filter(Boolean).join(' · ');

  function open(threadId: string) {
    finder.clear();
    onopen(threadId);
  }
</script>

<div class="card found" data-hit role="status" aria-busy={finder.searching} data-testid="companion-found">
  <header>
    <span class="mark" class:spin={finder.searching} aria-hidden="true">
      {#if finder.searching}<LoaderCircle size={14} />{:else}<Search size={14} />{/if}
    </span>
    <span class="heading">{heading}</span>
    <button class="ghost icon" aria-label={strings.companion.dismiss} title={strings.companion.dismiss} onclick={() => finder.clear()}><X size={13} /></button>
  </header>
  {#if found.length > 0}
    <ul>
      {#each found as match (match.thread.id)}
        <li>
          <button class="ghost row" title={copy.openHint} onclick={() => open(match.thread.id)} data-testid="companion-found-thread">
            <span class="title">{match.thread.title || strings.companion.untitled}</span>
            <span class="meta">{metaOf(match)}</span>
            {#if match.excerpt}<span class="excerpt">{match.excerpt}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .card {
    width: 380px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    animation: rise var(--dur-2) var(--ease-out-quint);
  }
  .found {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 8px;
  }
  .mark {
    flex: none;
    display: grid;
    color: var(--color-muted-foreground);
  }
  .spin {
    animation: spin 1s linear infinite;
  }
  .heading {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .icon {
    flex: none;
    width: 24px;
    height: 24px;
  }
  ul {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    height: auto;
    padding: 5px 8px;
    font-weight: 400;
    text-align: start;
    white-space: normal;
  }
  .title,
  .meta {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    font-size: var(--text-xs);
    font-weight: 600;
  }
  .meta {
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .excerpt {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--text-xs);
    line-height: 1.4;
    color: var(--color-muted-foreground);
    overflow-wrap: anywhere;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .spin {
      animation: none;
    }
  }
</style>
