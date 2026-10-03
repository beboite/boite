<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { AccountQuota, QuotaResetOutcome } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import { quotaAccountName, quotaReader } from '../lib/quota-reader.svelte';
  import { fill, strings } from '../lib/strings';
  import QuotaExtras from './QuotaExtras.svelte';

  let { row, store, disabled = false }: { row: AccountQuota; store: Store; disabled?: boolean } = $props();
  let busy = $state(false);
  let sending = $state(false);
  let status = $state<string | null>(null);
  let failed = $state(false);
  let disposed = false;
  let sourceClient: Store['client'] = null;
  let ownConfirm: typeof confirm.current = null;
  let available = $derived(['claude', 'codex'].includes(row.providerId) && row.enabled && row.status === 'ready' && !row.error && (row.resetCredits?.availableCount ?? 0) > 0);

  $effect(() => {
    const client = store.client;
    if (client === sourceClient) return;
    sourceClient = client;
    status = null;
    failed = false;
  });

  onDestroy(() => {
    disposed = true;
    if (ownConfirm && confirm.current === ownConfirm) confirm.answer(false);
  });

  async function reset() {
    const client = store.client;
    if (busy || disabled || !available || !client || !store.owner || store.connection !== 'ready') return;
    const accountId = row.accountId;
    const identity = store.accounts?.find(account => account.id === accountId)?.identity;
    const reader = quotaReader(store.endpointUrl ?? 'here');
    busy = true;
    try {
      const accepted = confirm.ask({
        title: fill(strings.quotas.resetConfirmTitle, { account: quotaAccountName(row) }),
        body: fill(strings.quotas.resetConfirmBody, { provider: row.providerName }),
        confirmLabel: strings.quotas.resetConfirm, cancelLabel: strings.common.cancel, danger: true,
      });
      ownConfirm = confirm.current;
      const sure = await accepted;
      ownConfirm = null;
      if (!sure || disposed || disabled || !available || store.client !== client || !store.owner || store.connection !== 'ready'
        || store.accounts?.find(account => account.id === accountId)?.identity !== identity) return;
      sending = true;
      status = null;
      failed = false;
      const result = await client.call('quotas.reset', { accountId, confirmed: true });
      reader.acceptReset(result.quota);
      if (disposed || store.client !== client) return;
      const outcomes: Record<QuotaResetOutcome, string> = { reset: strings.quotas.resetApplied, nothingToReset: strings.quotas.resetNothing,
        noCredit: strings.quotas.resetNoCredit, alreadyRedeemed: strings.quotas.resetAlreadyUsed };
      status = result.outcome === 'reset' && result.quota.status !== 'ready' ? strings.quotas.resetRefreshFailed : outcomes[result.outcome];
    } catch (error) {
      if (disposed || store.client !== client) return;
      failed = true;
      status = fill(strings.quotas.resetFailed, { error: error instanceof Error ? error.message : String(error) });
    } finally { busy = false; sending = false; }
  }
</script>

<QuotaExtras {row}>
  {#snippet resetAction()}
    {#if available}
      <button type="button" class="ghost small" data-testid="quota-use-reset" data-account-id={row.accountId}
        disabled={disabled || busy || !store.owner || store.connection !== 'ready'} aria-busy={sending} onclick={() => void reset()}>
        <span class="ui-label">{sending ? strings.quotas.resetUsing : strings.quotas.useReset}</span>
      </button>
    {/if}
  {/snippet}
</QuotaExtras>
{#if status}<p class:failed role="status" data-testid="quota-reset-status" data-account-id={row.accountId}>{status}</p>{/if}

<style>
  p { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; color: var(--color-muted-foreground); }
  p.failed { color: var(--color-danger); }
</style>
