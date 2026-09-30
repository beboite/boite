<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import { ConversationFocus } from '../lib/conversation-focus';

  let { store, visible }: { store: Store; visible: boolean } = $props();
  const focus = new ConversationFocus();
  $effect(() => {
    const client = store.connection === 'ready' ? store.client : null;
    const thread = store.openThread;
    focus.update(client, visible && store.page === 'chat' && thread && !thread.archived ? thread.id : null);
  });
  onDestroy(() => focus.close());
</script>
