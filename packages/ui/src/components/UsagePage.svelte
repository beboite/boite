<script lang="ts">
  import { cost, tokens } from '../lib/format';
  import { strings } from '../lib/i18n.svelte';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  let rows = $derived(
    Object.entries(store.usage?.byThread ?? {}).map(([threadId, usage]) => ({
      threadId,
      title: store.threads.find((t) => t.id === threadId)?.title ?? threadId,
      usage
    }))
  );
</script>

<div class="page" data-testid="usage-page">
  <header>
    <h1>{strings.usage.heading}</h1>
    <button class="quiet" onclick={() => void store.refreshUsage()}>{strings.common.refresh}</button>
  </header>

  <p class="note">{strings.usage.note}</p>

  {#if rows.length === 0}
    <p class="empty">{strings.usage.empty}</p>
  {:else}
    <table class="card">
      <thead>
        <tr>
          <th>{strings.usage.thread}</th>
          <th>{strings.usage.input}</th>
          <th>{strings.usage.output}</th>
          <th>{strings.usage.cacheRead}</th>
          <th>{strings.usage.cacheWrite}</th>
          <th>{strings.usage.cost}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.threadId)}
          <tr data-testid="usage-row" data-thread-id={row.threadId}>
            <td>
              <button class="quiet" onclick={() => void store.open(row.threadId)}>{row.title}</button>
            </td>
            <td class="mono">{tokens(row.usage.inputTokens)}</td>
            <td class="mono">{tokens(row.usage.outputTokens)}</td>
            <td class="mono">{tokens(row.usage.cacheReadTokens)}</td>
            <td class="mono">{tokens(row.usage.cacheWriteTokens)}</td>
            <td class="mono">{cost(row.usage.costUsdEquivalent)}</td>
          </tr>
        {/each}
      </tbody>
      {#if store.usage}
        <tfoot>
          <tr data-testid="usage-total">
            <td>{strings.usage.total}</td>
            <td class="mono">{tokens(store.usage.total.inputTokens)}</td>
            <td class="mono">{tokens(store.usage.total.outputTokens)}</td>
            <td class="mono">{tokens(store.usage.total.cacheReadTokens)}</td>
            <td class="mono">{tokens(store.usage.total.cacheWriteTokens)}</td>
            <td class="mono">{cost(store.usage.total.costUsdEquivalent)}</td>
          </tr>
        </tfoot>
      {/if}
    </table>
  {/if}
</div>

<style>
  .note {
    margin: 0 0 10px;
    color: var(--color-muted-foreground);
    border-left: 2px solid var(--color-edge);
    padding-left: 8px;
    max-width: 620px;
  }

  table {
    max-width: 780px;
  }

  tfoot td {
    font-weight: 600;
    border-top: 1px solid var(--color-edge);
  }

  tbody button {
    padding: 0;
  }

  /* A row under the pointer fills, the way every other list here answers. */
  tbody tr:hover td {
    background: var(--color-surface-2);
  }
</style>
