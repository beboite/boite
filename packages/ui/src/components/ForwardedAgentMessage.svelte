<script lang="ts">
  import { BellRing, CheckCheck, CornerDownLeft, Forward, UserCog } from '@lucide/svelte';
  import type { AgentAddress, AgentLetter } from '@boite/contracts';
  import { fill, strings } from '../lib/strings';
  import { exactTime, relativeTime } from '../lib/format';

  let { letter, self, projectName, onopen, compact = false }: {
    letter: AgentLetter; self: AgentAddress; projectName?: string; onopen?: (address: AgentAddress) => void; compact?: boolean;
  } = $props();
  let outgoing = $derived(letter.from.coreId === self.coreId && letter.from.threadId === self.threadId);
  /** A letter the user did not type never sits on the user's side, whoever received it. */
  let steward = $derived(letter.origin === 'steward');
  let notice = $derived(letter.origin === 'notice');
  let userSide = $derived(!steward && (!outgoing || letter.origin === 'user'));
  let address = $derived(outgoing ? letter.to : letter.from);
  let project = $derived(projectName ?? (outgoing ? letter.toProject : letter.from.project));
  let machine = $derived(outgoing ? letter.toMachine : letter.from.machine);
  let technical = $derived(letter.error ? `${strings.coordination.status[letter.status]}. ${letter.error}` : strings.coordination.status[letter.status]);
  let needsDetails = $derived(['uncertain', 'expired', 'rejected'].includes(letter.status));
  let status = $derived(!outgoing && letter.status === 'delivered' ? strings.coordination.receivedStatus : strings.coordination.bubbleStatus[letter.status]);
  let acknowledged = $derived(letter.status === 'received' || letter.status === 'delivered');
  let sourceLabel = $derived(steward
    ? outgoing ? strings.coordination.stewardSentTo : strings.coordination.stewardFrom
    : letter.origin === 'user'
      ? outgoing ? strings.coordination.userSentTo : strings.coordination.userMessageVia
      : outgoing ? strings.coordination.sentTo : strings.coordination.receivedFrom);
  let now = $state(Date.now());
  let hidden = $state(document.hidden);
  $effect(() => {
    if (hidden) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 60_000);
    return () => clearInterval(timer);
  });
</script>

<svelte:document onvisibilitychange={() => hidden = document.hidden} />
{#if notice}
  <!-- What the core told a steward about one of its threads: an event line, not a message anyone wrote. -->
  <div class="notice" class:compact data-testid="agent-notice" data-letter-id={letter.id} data-direction={outgoing ? 'outgoing' : 'incoming'} title={technical}>
    <button type="button" class="notice-head" data-testid="agent-letter-open" title={strings.chat.openLinkedThread} disabled={!onopen} onclick={() => onopen?.(address)}>
      <BellRing size={14} strokeWidth={1.75} aria-hidden="true" />
      <span class="notice-label">{fill(strings.coordination.noticeFrom, { title: outgoing ? letter.toTitle : letter.from.title })}</span>
    </button>
    <time class="when" data-testid="agent-letter-age" datetime={new Date(letter.createdAt).toISOString()} title={exactTime(letter.createdAt)}>{relativeTime(letter.createdAt, now)}</time>
    <p class="notice-body">{letter.text}</p>
  </div>
{:else}
<div class="forwarded" class:steward class:user={userSide} class:compact data-testid="forwarded-agent-message" data-letter-id={letter.id} data-direction={outgoing ? 'outgoing' : 'incoming'} title={technical}>
  <div class="forward-top">
    <button type="button" class="forward-head" data-testid="agent-letter-open" title={strings.chat.openLinkedThread} disabled={!onopen} onclick={() => onopen?.(address)}>
      <span class="forward-icon">
        {#if steward}<UserCog size={18} strokeWidth={1.75} aria-hidden="true" />
        {:else if outgoing}<Forward size={18} strokeWidth={1.75} aria-hidden="true" />
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
    <time class="when" data-testid="agent-letter-age" datetime={new Date(letter.createdAt).toISOString()} title={exactTime(letter.createdAt)}>{relativeTime(letter.createdAt, now)}</time>
  </div>
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
{/if}

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
  .forward-top { display: flex; align-items: flex-start; gap: 12px; }
  .forward-head { display: flex; flex: 1; min-width: 0; align-items: flex-start; justify-content: flex-start; gap: 9px; height: auto; padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; text-align: left; color: var(--color-muted-foreground); }
  .when { flex: none; font-size: var(--text-xs); color: var(--color-muted-foreground); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .forward-head:hover:not(:disabled) strong { text-decoration: underline; }
  .forward-head:disabled { opacity: 1; cursor: default; }
  .forwarded.user {
    margin-left: auto;
    background: var(--color-accent-soft);
    border-color: var(--color-accent);
    border-left-width: 1px;
    border-right-width: 2px;
    border-bottom-left-radius: var(--radius-lg);
    border-bottom-right-radius: var(--radius-sm);
  }
  .forwarded.user .forward-label,
  .forwarded.user .forward-icon { color: var(--color-accent); }
  /* The steward speaks for the owner's arrangement, not for the user: its own hue, on the agents' side. */
  .forwarded.steward {
    background: var(--color-steward-soft);
    border-color: color-mix(in oklch, var(--color-steward) 45%, transparent);
    border-left-color: var(--color-steward);
  }
  .forwarded.steward .forward-label,
  .forwarded.steward .forward-icon { color: var(--color-steward); font-weight: 600; }
  .notice {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 12px;
    max-width: min(78%, var(--prose));
    padding: 6px 10px;
    border-left: 2px solid var(--color-border);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  .notice-head { display: inline-flex; min-width: 0; align-items: center; justify-content: flex-start; gap: 6px; height: auto; padding: 0; border: 0; background: transparent; color: inherit; font-size: var(--text-xs); font-weight: 600; text-align: left; }
  .notice-head:hover:not(:disabled) .notice-label { text-decoration: underline; }
  .notice-head:disabled { opacity: 1; cursor: default; }
  .notice-head :global(svg) { flex: none; }
  .notice-label { overflow-wrap: anywhere; }
  .notice-body { grid-column: 1 / -1; margin: 0 0 0 20px; line-height: 1.45; overflow-wrap: anywhere; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .notice.compact { max-width: 100%; }
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
  .forwarded.compact { max-width: 94%; }
  .compact .body, .compact .foot { margin-left: 0; }
  @media (max-width: 720px) {
    .forwarded, .notice { max-width: 92%; }
    .notice-body { margin-left: 0; }
    .body, .foot { margin-left: 0; }
  }
</style>
