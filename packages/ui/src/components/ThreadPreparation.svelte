<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import { watchAttention } from '../lib/attention';
  import { ConversationFocus } from '../lib/conversation-focus';
  import { DRAFT_STASH_KEY } from '../lib/prefs';
  import { rightPanel } from '../lib/right-panel.svelte';

  let { store, visible }: { store: Store; visible: boolean } = $props();
  const focus = new ConversationFocus();
  let attentive = $state(false);
  onMount(() => watchAttention((value) => { attentive = value; }, (at) => focus.activity(at)));
  $effect(() => {
    const client = store.connection === 'ready' ? store.client : null;
    const thread = store.openThread;
    const protectedIds = new Set(Object.entries(store.composerStates)
      .filter(([id, input]) => id !== DRAFT_STASH_KEY && !!(input.text || input.attachments.length || input.previewReferences?.length || input.queued.length || input.sending || input.editing))
      .map(([id]) => id));
    for (const row of store.threads) if (rightPanel.drafts.get(store.threadKey(row.id))?.size) protectedIds.add(row.id);
    focus.update(client, visible && store.page === 'chat' && thread && !thread.archived ? thread.id : null, [...protectedIds], !store.draftsReadable, attentive);
  });
  onDestroy(() => focus.close());
</script>
