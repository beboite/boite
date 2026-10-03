<script lang="ts">
  import type { Message, Turn } from '@boite/contracts';
  import type { Snippet } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import TurnSummary from './TurnSummary.svelte';

  let { store, threadId, turn, message, actions }: {
    store: Store;
    threadId: string;
    turn: Turn;
    message: Message;
    actions?: Snippet;
  } = $props();

  const tail = $derived(message.parts.at(-1));
  // The streaming text owns its dots, even before its first paragraph is shown.
  const activeContent = $derived(message.role === 'assistant' && message.state === 'streaming' &&
    (tail?.type === 'text' && tail.complete !== true || tail?.type === 'thinking' && tail.finishedAt == null));
</script>

<TurnSummary
  {turn}
  progress={store.openThread?.id === threadId ? store.openThread.progress : undefined}
  activeTool={message.parts.some(part => part.type === 'tool' && part.status === 'running')}
  {activeContent}
  typing={store.connection === 'ready' && !activeContent}
  waiting={store.openThread?.status === 'waiting' && turn.status === 'running'}
  background={store.openThread?.turns.at(-1)?.id === turn.id ? store.openThread?.background ?? [] : []}
  stop={() => void store.stop()}
  {actions}
/>
