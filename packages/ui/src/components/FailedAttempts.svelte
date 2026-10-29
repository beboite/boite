<script lang="ts">
  import { Activity, ChevronRight } from '@lucide/svelte';
  import type { Account, Message, Turn } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { clockTime, exactTime } from '../lib/format';
  import { fill, strings } from '../lib/strings';
  import { promptText } from '../lib/message-display';
  import ErrorCard from './ErrorCard.svelte';
  import Prose from './Prose.svelte';
  import TurnSummary from './TurnSummary.svelte';
  import MessageActions from './MessageActions.svelte';
  import AssistantMessage from './AssistantMessage.svelte';

  let { store, threadId, messages, turns, signedOut, canFork, reveal, oninspect }: {
    store: Store; threadId: string; messages: readonly Message[]; turns: Turn[];
    signedOut: Account | null; canFork: boolean; reveal: { id: string } | null;
    oninspect: (opening: boolean) => void;
  } = $props();
  let expanded = $state(false);
  const attempts = $derived(messages.filter(message => message.role === 'assistant'));
  const errors = (message: Message) => message.parts.filter(part => part.type === 'error').map(part => part.message).join('\n');
  const first = $derived(turns.find(turn => turn.id === attempts[0]?.turnId));
  const last = $derived(turns.find(turn => turn.id === attempts.at(-1)?.turnId));
  const account = $derived(store.owner ? signedOut : null);
  function reconnect() { if (account) store.openConnect(account.providerId, account.id); }
  $effect(() => { if (reveal && messages.some(message => message.id === reveal.id)) expanded = true; });
</script>

<div data-testid="failed-attempts">
  <ErrorCard message={errors(attempts.at(-1)!)} reconnect={account ? reconnect : undefined}>
    {#snippet history()}
      <details bind:open={expanded} data-testid="failed-attempts-history" ontoggle={event => { if (!event.currentTarget.open) oninspect(false); }}>
        <summary data-testid="failed-attempts-toggle" onclick={() => { if (!expanded) oninspect(true); }}>
          <ChevronRight size={14} strokeWidth={1.75} />
          <span class="ui-label">{fill(strings.chat.failedAttempts, { count: String(attempts.length) })}</span>
          {#if first && last}<span class="range" title={`${exactTime(first.startedAt ?? first.queuedAt)} - ${exactTime(last.finishedAt ?? last.queuedAt)}`}>{clockTime(first.startedAt ?? first.queuedAt)} - {clockTime(last.finishedAt ?? last.queuedAt)}</span>{/if}
        </summary>
        {#if expanded}
          <div class="history">
            {#each messages as message (message.id)}
              <div class="entry" data-mid={`failure:${message.id}`} data-testid="failed-attempt-entry">
                {#if message.role === 'system'}
                  <div class="wake" data-testid="message-system" role="note" aria-label={strings.chat.system}><Activity size={13} aria-hidden="true" /><div>{#each message.parts as part}{#if part.type === 'text'}<Prose text={promptText(part)} {store} {threadId} />{/if}{/each}</div></div>
                {:else}
                  {@const turn = turns.find(turn => turn.id === message.turnId)}
                  <AssistantMessage {store} {threadId} {message} from={0} to={0} {signedOut} showModel={true} />
                  <pre data-testid="error-diagnostic">{errors(message)}</pre>
                  {#if turn}<TurnSummary {turn} clockOffset={store.clockOffset}>
                    {#snippet actions()}<MessageActions text={() => errors(message)} fork={canFork ? worktree => void store.fork(message.id, { worktree }) : undefined} />{/snippet}
                  </TurnSummary>{/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </details>
    {/snippet}
  </ErrorCard>
</div>

<style>
  details { margin-top: 6px; }
  summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: var(--control-sm); border-radius: var(--radius-sm); color: var(--color-muted-foreground); font-size: var(--text-xs); cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--color-foreground); }
  summary :global(svg) { transition: transform var(--dur-2) var(--ease-out-quint); flex: none; }
  details[open] summary :global(svg) { transform: rotate(90deg); }
  .range { margin-left: auto; font-variant-numeric: tabular-nums; font-size: var(--text-xs); }
  .history { margin-top: 10px; border-top: 1px solid var(--color-border); }
  .entry { min-width: 0; }
  .wake { display: flex; align-items: center; gap: 7px; margin-top: 16px; color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .wake :global(svg) { flex: none; }
  pre { margin: 8px 0 0; padding: 10px 12px; border-left: 2px solid var(--color-border); color: var(--color-muted-foreground); font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  @media (max-width: 720px) { summary { min-height: var(--control-touch); } }
</style>
