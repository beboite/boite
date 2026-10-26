<script lang="ts">
  import { CircleAlert, Clock, PencilLine } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { machineName, workspace } from '../lib/workspace.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator } from '../lib/menu';
  import { longPress } from '../lib/long-press';
  import { fill, strings } from '../lib/strings';

  /**
   * One unsent draft. A project can hold several, each its own row; choosing
   * one brings back exactly that draft. Its menu, on a right click or a long
   * press, opens or deletes it. `onopen` runs once it is open, so the phone
   * can show the chat. A draft sent while its machine was away waits under a
   * clock until its conversation starts, and its menu can take the send back.
   */
  let { owner, entry, onopen }: { owner: Store; entry: Store['draftEntries'][number]; onopen?: () => void } = $props();
  let active = $derived(entry.active && workspace.active === owner);
  let machine = $derived.by(() => { const found = workspace.machines.find(item => item.store === owner); return found ? machineName(found) : strings.machines.local; });
  let tooltip = $derived(
    entry.queued === 'waiting' ? `${entry.text}\n${fill(strings.sidebar.draftQueued, { machine })}`
      : entry.queued === 'starting' ? `${entry.text}\n${fill(strings.sidebar.draftStarting, { machine })}`
      : entry.queued ? `${entry.text}\n${fill(strings.sidebar.draftQueueFailed, { reason: entry.queued.failed })}`
      : entry.text || strings.sidebar.draft
  );
  async function open() {
    await workspace.select(owner, undefined, entry.projectId, { draftId: entry.id });
    onopen?.();
  }
  function menu(event: MouseEvent) {
    // A start on its way is not taken back: the core may already hold the conversation.
    const starting = entry.queued === 'starting';
    contextMenu.open(event, [
      { id: 'open', label: strings.common.open },
      ...(entry.queued && !starting && !entry.asked ? [{ id: 'unqueue', label: strings.sidebar.cancelQueuedDraft }] : []),
      ...(starting ? [] : [separator(), { id: 'delete', label: strings.sidebar.deleteDraft, danger: true }])
    ], action => {
      if (action === 'open') void open();
      if (action === 'unqueue') owner.cancelQueuedDraft(entry.id);
      if (action === 'delete') owner.discardDraft(entry.id);
    });
  }
</script>

<button class="ghost draft" class:active class:failed={entry.queued !== null && typeof entry.queued !== 'string'} data-testid="draft-row" data-project-id={entry.projectId ?? ''} data-draft-id={entry.id}
  data-queued={entry.queued === null ? undefined : typeof entry.queued === 'string' ? entry.queued : 'failed'}
  aria-current={active ? 'page' : undefined} title={tooltip} onclick={open} oncontextmenu={menu} use:longPress>
  {#if entry.queued === 'waiting' || entry.queued === 'starting'}<Clock size={14} aria-hidden="true" />
  {:else if entry.queued}<CircleAlert size={14} aria-hidden="true" />
  {:else if entry.text}<PencilLine size={14} aria-hidden="true" />{:else}<span class="mark" aria-hidden="true"></span>{/if}
  <span class="title ui-label">{entry.text || strings.sidebar.draft}</span>
</button>

<style>
  .draft { width: 100%; height: auto; min-height: var(--row); justify-content: flex-start; gap: 8px; padding: 8px 10px; font-weight: 400; -webkit-touch-callout: none; }
  .draft.active { background: var(--color-active); }
  .draft :global(svg) { flex: none; color: var(--color-accent); }
  .draft[data-queued='waiting'] :global(svg) { color: var(--color-muted-foreground); }
  .draft[data-queued='starting'] :global(svg) { color: var(--color-accent); }
  .draft.failed :global(svg) { color: var(--color-danger); }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .mark { width: 8px; height: 8px; flex: none; border-radius: 50%; border: 1.5px dashed var(--color-muted-foreground); }
</style>
