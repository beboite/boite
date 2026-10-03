<script lang="ts">
  import { PauseCircle } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';

  let { store }: { store: Store } = $props();
  let pending = $state(false);
  let held = $derived(store.scheduler?.queued.find(entry => entry.threadId === store.openThread?.id && entry.queueHold));
  let execution = $derived(store.openThread?.turns.find(turn => turn.id === held?.turnId)?.execution);
  let target = $derived(execution ? fill(strings.thread.recoveryTarget, {
    model: execution.model ?? store.providerOf(execution.providerId)?.name ?? execution.providerId,
    account: store.accounts.find(account => account.id === execution.accountId)?.label ?? execution.accountId,
  }) : null);

  async function recover(action: 'resume' | 'discard') {
    if (!held || pending) return;
    const { threadId, turnId } = held;
    pending = true;
    try { await store.recoverTurn(threadId, turnId, action); }
    finally { pending = false; }
  }
</script>

{#if held}
  <aside class="recovery" data-testid="thread-recovery" aria-label={strings.thread.recoveryTitle}>
    <PauseCircle size={18} aria-hidden="true" />
    <div class="body">
      <p class="title">{strings.thread.recoveryTitle}</p>
      <p>{strings.thread.recoveryBody}</p>
      {#if target}<p class="target">{target}</p>{/if}
      <div class="actions">
        <button class="small primary" disabled={pending || store.connection !== 'ready'} onclick={() => recover('resume')}>{strings.thread.recoveryResume}</button>
        <button class="small ghost" disabled={pending || store.connection !== 'ready'} onclick={() => recover('discard')}>{strings.thread.recoveryDiscard}</button>
      </div>
    </div>
  </aside>
{/if}

<style>
  .recovery { display: flex; gap: 10px; margin: 8px 16px; padding: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
  .recovery > :global(svg) { flex: none; color: var(--color-muted-foreground); margin-top: 2px; }
  .body { min-width: 0; }
  p { margin: 0; font-size: var(--text-sm); }
  .title { font-weight: 600; margin-bottom: 4px; }
  .target { color: var(--color-muted-foreground); margin-top: 6px; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
</style>
