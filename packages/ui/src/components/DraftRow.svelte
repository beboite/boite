<script lang="ts">
  import { PencilLine } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { contextMenu } from '../lib/context-menu.svelte';
  import { separator } from '../lib/menu';
  import { longPress } from '../lib/long-press';
  import { strings } from '../lib/strings';

  /**
   * One unsent draft. A project can hold several, each its own row; choosing
   * one brings back exactly that draft. Its menu, on a right click or a long
   * press, opens or deletes it. `onopen` runs once it is open, so the phone
   * can show the chat.
   */
  let { owner, entry, onopen }: { owner: Store; entry: Store['draftEntries'][number]; onopen?: () => void } = $props();
  let active = $derived(entry.active && workspace.active === owner);
  async function open() {
    if (workspace.active !== owner) await workspace.select(owner);
    owner.startDraft(entry.projectId, { draftId: entry.id });
    onopen?.();
  }
  function menu(event: MouseEvent) {
    contextMenu.open(event, [
      { id: 'open', label: strings.sidebar.open },
      separator(),
      { id: 'delete', label: strings.sidebar.deleteDraft, danger: true }
    ], action => {
      if (action === 'open') void open();
      if (action === 'delete') owner.discardDraft(entry.id);
    });
  }
</script>

<button class="ghost draft" class:active data-testid="draft-row" data-project-id={entry.projectId ?? ''} data-draft-id={entry.id}
  aria-current={active ? 'page' : undefined} title={entry.text || strings.sidebar.draft} onclick={open} oncontextmenu={menu} use:longPress>
  {#if entry.text}<PencilLine size={14} aria-hidden="true" />{:else}<span class="mark" aria-hidden="true"></span>{/if}
  <span class="title ui-label">{entry.text || strings.sidebar.draft}</span>
</button>

<style>
  .draft { width: 100%; height: auto; min-height: var(--row); justify-content: flex-start; gap: 8px; padding: 8px 10px; font-weight: 400; -webkit-touch-callout: none; }
  .draft.active { background: var(--color-active); }
  .draft :global(svg) { flex: none; color: var(--color-accent); }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .mark { width: 8px; height: 8px; flex: none; border-radius: 50%; border: 1.5px dashed var(--color-muted-foreground); }
</style>
