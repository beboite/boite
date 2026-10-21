<script lang="ts">
  import { Check } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import MessageActions from './MessageActions.svelte';

  /**
   * What a prompt shows under its bubble, in a thread and in an agent's
   * conversation alike: its actions and send time, then two ticks, received
   * and answered. Once both are in, the ticks wait for the pointer like the time.
   */
  let { text, at, edit, accepted, responded, agent = false }: {
    text: string;
    at: number;
    edit?: () => void;
    accepted: boolean;
    responded: boolean;
    /** A prompt another agent wrote sits on the agents' side. */
    agent?: boolean;
  } = $props();
</script>

<div class="receipts" class:agent class:settled={accepted && responded} data-testid="message-receipts">
  <MessageActions {text} {at} {edit} />
  <span class="tick" data-testid="receipt-accepted" class:received={accepted} title={strings.chat.accepted} aria-label={strings.chat.accepted}><Check size={12} /></span>
  <span class="tick" data-testid="receipt-responded" class:received={responded} title={strings.chat.responseStarted} aria-label={strings.chat.responseStarted}><Check size={12} /></span>
</div>

<style>
  .receipts { display: flex; align-items: center; gap: 1px; margin: 4px 2px 0; color: var(--color-muted-foreground); }
  .receipts .tick { display: flex; opacity: .45; }
  .receipts .received { color: var(--color-accent); opacity: 1; }
  /* Delivered and answered: the ticks wait for the pointer like the time beside them. A pending one stays. */
  .receipts.settled .tick { opacity: 0; transition: opacity var(--dur-2); }
  :global(.message:hover) .receipts.settled .tick, .receipts.settled:focus-within .tick, .receipts.settled:not(:has(button)) .tick { opacity: 1; }
  @media (hover: none) { .receipts.settled .tick { opacity: 1; } }
  .receipts.agent { align-self: flex-start; }
</style>
