<script lang="ts">
  import { CornerDownLeft, Forward } from '@lucide/svelte';
  import type { AgentAddress, AgentLetter } from '@boite/contracts';
  import { strings } from '../lib/strings';

  let { letter, self }: { letter: AgentLetter; self: AgentAddress } = $props();
  let outgoing = $derived(letter.from.coreId === self.coreId && letter.from.threadId === self.threadId);
  let technical = $derived(letter.error ? `${strings.coordination.status[letter.status]}. ${letter.error}` : strings.coordination.status[letter.status]);
  let needsDetails = $derived(['uncertain', 'expired', 'rejected'].includes(letter.status));
  let status = $derived(!outgoing && letter.status === 'delivered' ? strings.coordination.receivedStatus : strings.coordination.bubbleStatus[letter.status]);
  let sourceLabel = $derived(letter.origin === 'user'
    ? outgoing ? strings.coordination.userSentTo : strings.coordination.userMessageVia
    : outgoing ? strings.coordination.sentTo : strings.coordination.receivedFrom);
</script>

<div class="forwarded" data-testid="forwarded-agent-message" data-letter-id={letter.id} data-direction={outgoing ? 'outgoing' : 'incoming'} title={technical}>
  <div class="forward-head">
    <span class="forward-icon">
      {#if outgoing}<Forward size={18} strokeWidth={1.75} aria-hidden="true" />
      {:else}<CornerDownLeft size={18} strokeWidth={1.75} aria-hidden="true" />{/if}
    </span>
    <div class="source">
      <span class="forward-label">{sourceLabel}</span>
      <strong>{outgoing ? letter.toTitle : letter.from.title}</strong>
      {#if !outgoing}<span>{letter.from.machine}</span>{/if}
    </div>
  </div>
  <p class="body">{letter.text}</p>
  <div class="foot">
    {#if needsDetails}
      <details class="status-details">
        <summary data-testid="agent-letter-status" data-status={letter.status}>{strings.coordination.bubbleStatus[letter.status]}</summary>
        <p>{technical}</p>
      </details>
    {:else}
      <span data-testid="agent-letter-status" data-status={letter.status}>{status}</span>
    {/if}
  </div>
</div>

<style>
  .forwarded {
    width: fit-content;
    max-width: min(78%, var(--prose));
    padding: 10px 12px 9px;
    border: 1px solid var(--color-border);
    border-left: 2px solid var(--color-edge);
    border-radius: var(--radius-lg);
    border-bottom-left-radius: var(--radius-sm);
    background: var(--color-surface-2);
    box-shadow: var(--shadow-e1);
  }
  .forward-head { display: flex; align-items: flex-start; gap: 9px; color: var(--color-muted-foreground); }
  .forwarded[data-direction="outgoing"] {
    margin-left: auto;
    background: var(--color-accent-soft);
    border-color: var(--color-accent);
    border-left-width: 1px;
    border-right-width: 2px;
    border-bottom-left-radius: var(--radius-lg);
    border-bottom-right-radius: var(--radius-sm);
  }
  .forwarded[data-direction="outgoing"] .forward-label,
  .forwarded[data-direction="outgoing"] .forward-icon { color: var(--color-accent); }
  .forward-icon { flex: 0 0 auto; display: flex; margin-top: 2px; color: var(--color-foreground); }
  .source { min-width: 0; display: grid; grid-template-columns: auto 1fr; column-gap: 6px; align-items: baseline; }
  .source .forward-label { grid-column: 1 / -1; font-size: var(--text-xs); }
  .source strong { overflow: hidden; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  .source > span:last-child { overflow: hidden; font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
  .body { margin: 7px 0 0 27px; color: var(--color-foreground); font-size: var(--text-base); line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
  .foot { margin: 7px 0 0 27px; display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .status-details summary { width: fit-content; cursor: pointer; }
  .status-details p { margin-top: 5px; max-width: 48ch; line-height: 1.45; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .forwarded { max-width: 92%; }
    .source { grid-template-columns: 1fr; }
    .source .forward-label { grid-column: auto; }
    .body, .foot { margin-left: 0; }
  }
</style>
