<script lang="ts">
  import { ArchiveRestore } from '@lucide/svelte';
  import type { ThreadId } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { restoreThread } from '../lib/archive';
  import { strings } from '../lib/strings';

  let { store, threadId }: { store: Store; threadId: ThreadId } = $props();
  let restoring = $state(false);

  async function reopen(): Promise<void> {
    const owner = store;
    const id = threadId;
    restoring = true;
    try {
      const summary = await restoreThread(owner, id);
      if (owner.openThread?.id === id) Object.assign(owner.openThread, summary);
    } catch (error) { owner.error = error instanceof Error ? error.message : String(error); }
    finally { restoring = false; }
  }
</script>

<div class="done-notice" data-testid="done-thread-notice">
  <span class="ui-label">{strings.sidebar.doneNotice}</span>
  <button type="button" class="small" data-testid="done-thread-reopen" disabled={restoring || store.connection !== 'ready'} onclick={() => void reopen()}><ArchiveRestore size={14} /><span class="ui-label">{strings.sidebar.reopenThread}</span></button>
</div>

<style>
  .done-notice { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--color-border); color: var(--color-muted-foreground); font-size: var(--text-sm); }
  button { gap: 6px; }
  @media (max-width: 720px) { button { min-height: var(--touch-target); } }
</style>
