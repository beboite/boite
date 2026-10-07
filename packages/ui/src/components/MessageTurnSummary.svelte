<script lang="ts">
  import { requestStarts, type Message, type Turn } from '@boite/contracts';
  import type { Snippet } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import TurnSummary from './TurnSummary.svelte';

  let { store, threadId, turn, turns = [], message, messages, actions }: {
    store: Store;
    threadId: string;
    turn: Turn;
    /** The shown thread's turns, to find when the request this turn carries on started (`requestStarts`). */
    turns?: Turn[];
    message: Message;
    messages: Message[];
    actions?: Snippet;
  } = $props();

  const active = $derived(turn.status === 'running' ? messages.filter(current => current.turnId === turn.id && current.role === 'assistant') : []);
  // A steering prompt moves the summary, but the preceding reasoning and tools keep working.
  // Only the last message owns text dots, even before its first paragraph is shown.
  const activeContent = $derived(active.some(current => {
    const tail = current.parts.at(-1);
    return current.state === 'streaming' && (tail?.type === 'thinking' && tail.finishedAt == null ||
      current.id === message.id && tail?.type === 'text' && tail.complete !== true);
  }));
  const requestStartedAt = $derived(requestStarts(turns).get(turn.id) ?? null);
</script>

<TurnSummary
  {turn}
  {requestStartedAt}
  progress={store.openThread?.id === threadId ? store.openThread.progress : undefined}
  activeTool={active.some(current => current.parts.some(part => part.type === 'tool' && part.status === 'running'))}
  {activeContent}
  typing={store.connection === 'ready' && !activeContent}
  waiting={store.openThread?.status === 'waiting' && turn.status === 'running'}
  background={store.openThread?.turns.at(-1)?.id === turn.id ? store.openThread?.background ?? [] : []}
  stop={() => void store.stop()}
  {actions}
/>
