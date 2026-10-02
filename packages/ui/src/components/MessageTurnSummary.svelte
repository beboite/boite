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
</script>

<TurnSummary
  {turn}
  progress={store.openThread?.id === threadId ? store.openThread.progress : undefined}
  activeTool={message.parts.some(part => part.type === 'tool' && part.status === 'running')}
  waiting={store.openThread?.status === 'waiting' && turn.status === 'running'}
  background={store.openThread?.turns.at(-1)?.id === turn.id ? store.openThread?.background ?? [] : []}
  stop={() => void store.stop()}
  {actions}
/>
