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
  // Each list is a string, so a keystroke that leaves it unchanged stops here:
  // typing reruns only the composer filter, never the walk over every thread.
  const composerIds = $derived(JSON.stringify(Object.entries(store.composerStates)
    .filter(([id, input]) => id !== DRAFT_STASH_KEY && !!(input.text || input.attachments.length || input.previewReferences?.length || input.queued.length || input.sending || input.editing))
    .map(([id]) => id)));
  const panelIds = $derived(JSON.stringify(store.threads.filter((row) => rightPanel.documents.drafted(store.threadKey(row.id))).map((row) => row.id)));
  $effect(() => {
    const client = store.connection === 'ready' ? store.client : null;
    const thread = store.openThread;
    const protectedIds = new Set<string>([...JSON.parse(composerIds) as string[], ...JSON.parse(panelIds) as string[]]);
    focus.update(client, visible && store.page === 'chat' && thread && !thread.archived ? thread.id : null, [...protectedIds], !store.draftsReadable, attentive);
  });
  onDestroy(() => focus.close());
</script>
