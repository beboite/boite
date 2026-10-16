<script lang="ts">
  import { Hourglass } from '@lucide/svelte';
  import { clockTime, elapsed } from '../lib/format';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * What the core will try again by itself on the open thread: the next try
   * of a turn the model refused at capacity, or the resume of a thread a usage
   * limit stopped, with its countdown and a way to give it up. Stop does the
   * same from the composer.
   */
  let { store }: { store: Store } = $props();
  let retry = $derived(store.openThread?.retry ?? null);
  let now = $state(Date.now());
  let pending = $state(false);

  $effect(() => {
    if (!retry) return;
    now = Date.now();
    // A second is the countdown's finest step; a long wait for a reset needs no more.
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  let left = $derived(retry ? elapsed(Math.max(0, retry.at - now)) : '');
  let body = $derived(!retry ? '' : retry.kind === 'capacity'
    ? fill(strings.thread.retryCapacityBody, { time: left, attempt: String(retry.attempt), attempts: String(retry.attempts) })
    : fill(strings.thread.retryLimitBody, { time: clockTime(retry.at, now), in: left }));

  async function cancel() {
    const threadId = store.openThread?.id;
    if (!threadId || pending) return;
    pending = true;
    try { await store.cancelRetry(threadId); }
    finally { pending = false; }
  }
</script>

{#if retry}
  <aside class="retry" data-testid="thread-retry" data-kind={retry.kind} aria-label={retry.kind === 'capacity' ? strings.thread.retryCapacityTitle : strings.thread.retryLimitTitle}>
    <Hourglass size={18} aria-hidden="true" />
    <div class="body">
      <p class="title ui-label-box"><span class="ui-label">{retry.kind === 'capacity' ? strings.thread.retryCapacityTitle : strings.thread.retryLimitTitle}</span></p>
      <p class="countdown" role="timer" aria-live="off">{body}</p>
    </div>
    <button class="small ghost" data-testid="thread-retry-cancel" disabled={pending || store.connection !== 'ready'} onclick={cancel}>
      <span class="ui-label">{retry.kind === 'capacity' ? strings.thread.retryCapacityCancel : strings.thread.retryLimitCancel}</span>
    </button>
  </aside>
{/if}

<style>
  .retry { box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: calc(100% - 32px); max-width: var(--content); margin: 8px auto 0; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
  .retry > :global(svg) { flex: none; color: var(--color-muted-foreground); }
  .body { flex: 1; min-width: 0; }
  p { margin: 0; font-size: var(--text-sm); }
  .title { display: flex; font-weight: 600; margin-bottom: 2px; }
  .countdown { color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  button { flex: none; }
  @media (max-width: 720px) { .retry { width: calc(100% - 24px); } }
  @media (max-width: 480px) {
    .retry { flex-wrap: wrap; }
    button { margin-left: 28px; }
  }
</style>
