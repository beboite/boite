<script lang="ts">
  import { CheckCheck, CornerDownLeft, Forward } from '@lucide/svelte';
  import type { AgentAddress, AgentLetter } from '@boite/contracts';
  import { strings } from '../lib/strings';

  let { letter, self, projectName, onopen }: {
    letter: AgentLetter; self: AgentAddress; projectName?: string; onopen?: (address: AgentAddress) => void;
  } = $props();
  let outgoing = $derived(letter.from.coreId === self.coreId && letter.from.threadId === self.threadId);
  let address = $derived(outgoing ? letter.to : letter.from);
  let project = $derived(projectName ?? (outgoing ? letter.toProject : letter.from.project));
  let machine = $derived(outgoing ? letter.toMachine : letter.from.machine);
  let technical = $derived(letter.error ? `${strings.coordination.status[letter.status]}. ${letter.error}` : strings.coordination.status[letter.status]);
  let needsDetails = $derived(['uncertain', 'expired', 'rejected'].includes(letter.status));
  let status = $derived(!outgoing && letter.status === 'delivered' ? strings.coordination.receivedStatus : strings.coordination.bubbleStatus[letter.status]);
  let acknowledged = $derived(letter.status === 'received' || letter.status === 'delivered');
  let sourceLabel = $derived(letter.origin === 'user'
    ? outgoing ? strings.coordination.userSentTo : strings.coordination.userMessageVia
    : outgoing ? strings.coordination.sentTo : strings.coordination.receivedFrom);
</script>

<div class="forwarded" data-testid="forwarded-agent-message" data-letter-id={letter.id} data-direction={outgoing ? 'outgoing' : 'incoming'} title={technical}>
  <button type="button" class="forward-head" data-testid="agent-letter-open" title={strings.chat.openLinkedThread} disabled={!onopen} onclick={() => onopen?.(address)}>
    <span class="forward-icon">
      {#if outgoing}<Forward size={18} strokeWidth={1.75} aria-hidden="true" />
      {:else}<CornerDownLeft size={18} strokeWidth={1.75} aria-hidden="true" />{/if}
    </span>
    <span class="source">
      <span class="forward-label">{sourceLabel}</span>
      <strong>{outgoing ? letter.toTitle : letter.from.title}</strong>
      <span class="source-context">
        {#if project}<span class="project" data-testid="agent-letter-project">{project}</span>{/if}
        {#if project && machine}<span aria-hidden="true">·</span>{/if}
        {#if machine}<span class="machine">{machine}</span>{/if}
      </span>
    </span>
  </button>
  <p class="body">{letter.text}</p>
  <div class="foot">
    {#if needsDetails}
      <details class="status-details">
        <summary data-testid="agent-letter-status" data-status={letter.status}>{strings.coordination.bubbleStatus[letter.status]}</summary>
        <p>{technical}</p>
      </details>
    {:else}
      <span data-testid="agent-letter-status" data-status={letter.status} aria-label={acknowledged ? technical : undefined} title={technical}>
        {#if acknowledged}<CheckCheck size={16} strokeWidth={1.75} aria-hidden="true" />{:else}{status}{/if}
      </span>
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
  .forward-head { display: flex; align-items: flex-start; justify-content: flex-start; gap: 9px; width: 100%; height: auto; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; text-align: left; color: var(--color-muted-foreground); }
  .forward-head:hover:not(:disabled) strong { text-decoration: underline; }
  .forward-head:disabled { opacity: 1; cursor: default; }
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
  .source { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .source .forward-label { font-size: var(--text-xs); }
  .source strong { color: var(--color-foreground); font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; white-space: normal; }
  .source-context { display: flex; flex-wrap: wrap; gap: 4px 6px; font-size: var(--text-xs); }
  .project { color: var(--color-foreground); }
  .project, .machine { overflow-wrap: anywhere; }
  .body { margin: 7px 0 0 27px; color: var(--color-foreground); font-size: var(--text-base); line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
  .foot { margin: 7px 0 0 27px; display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .status-details summary { width: fit-content; cursor: pointer; }
  .status-details p { margin-top: 5px; max-width: 48ch; line-height: 1.45; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .forwarded { max-width: 92%; }
    .body, .foot { margin-left: 0; }
  }
</style>
