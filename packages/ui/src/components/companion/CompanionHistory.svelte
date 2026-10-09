<!--
  The companion's earlier exchanges, read from its thread each time the list
  opens (`lib/companion/history.ts`): the request as typed, the reply as the
  bubble showed it. A click puts the reply back in the bubble.
-->
<script lang="ts">
  import type { Client } from '../../lib/client';
  import { readHistory, type Exchange } from '../../lib/companion/history';
  import { strings } from '../../lib/strings';

  interface Props {
    /** The page's connection, read when the list opens. */
    client: () => Client | null;
    threadId: string | null;
    onpick: (exchange: Exchange) => void;
  }

  let { client, threadId, onpick }: Props = $props();

  const copy = strings.companion.history;

  let exchanges = $state.raw<Exchange[] | null>(null);
  let failed = $state(false);

  $effect(() => {
    const [source, thread] = [client(), threadId];
    exchanges = null;
    failed = false;
    if (!source || !thread) {
      exchanges = [];
      return;
    }
    let live = true;
    readHistory(source, thread)
      .then((list) => {
        if (live) exchanges = list;
      })
      .catch(() => {
        if (live) failed = true;
      });
    return () => {
      live = false;
    };
  });

  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<section class="history" aria-label={copy.title} data-testid="companion-history">
  <h3>{copy.title}</h3>
  {#if failed}
    <p class="none problem" role="alert">{copy.failed}</p>
  {:else if exchanges === null}
    <p class="none">{copy.loading}</p>
  {:else if exchanges.length === 0}
    <p class="none">{copy.empty}</p>
  {:else}
    <ul>
      {#each exchanges as exchange (exchange.id)}
        <li>
          <button class="ghost row" title={copy.pick} disabled={!exchange.reply} onclick={() => onpick(exchange)} data-testid="companion-history-row">
            <span class="ask"><span class="request">{exchange.request}</span><span class="at">{time(exchange.at)}</span></span>
            <span class="reply" class:empty={!exchange.reply}>{exchange.reply || copy.noReply}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .history {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: 1px solid var(--color-border);
    animation: unfold var(--dur-2) var(--ease-out-quint);
  }
  h3 {
    margin: 8px 14px 4px;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-muted-foreground);
  }
  ul {
    max-height: 210px;
    margin: 0;
    padding: 0 6px 6px;
    overflow-y: auto;
    list-style: none;
    scrollbar-width: thin;
  }
  .row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    width: 100%;
    height: auto;
    padding: 6px 8px;
    font-weight: 400;
    text-align: start;
    white-space: normal;
  }
  .row:disabled {
    opacity: 1;
    cursor: default;
  }
  .ask {
    display: flex;
    gap: 8px;
    min-width: 0;
    font-size: var(--text-xs);
  }
  .request {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .at {
    flex: none;
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .reply {
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
  .reply.empty {
    font-style: italic;
  }
  .none {
    margin: 0 14px 8px;
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }
  .problem {
    color: var(--color-danger);
  }
  @keyframes unfold {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .history {
      animation: none;
    }
  }
</style>
