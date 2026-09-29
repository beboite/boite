<script lang="ts">
  import { PencilLine } from '@lucide/svelte';
  import type { Store } from '../lib/store.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { strings } from '../lib/strings';
  let { owner, entry }: { owner: Store; entry: Store['draftEntries'][number] } = $props();
  let active = $derived(entry.active && workspace.active === owner);
  async function open() {
    if (workspace.active !== owner) await workspace.select(owner);
    owner.startDraft(entry.projectId);
  }
</script>

<button class="ghost draft" class:active data-testid="draft-row" data-project-id={entry.projectId ?? ''}
  aria-current={active ? 'page' : undefined} title={entry.text || strings.sidebar.draft} onclick={open}>
  {#if entry.text}<PencilLine size={14} aria-hidden="true" />{:else}<span class="mark" aria-hidden="true"></span>{/if}
  <span class="title">{entry.text || strings.sidebar.draft}</span>
</button>

<style>
  .draft { width: 100%; height: auto; min-height: var(--row); justify-content: flex-start; gap: 8px; padding: 8px 10px; font-weight: 400; }
  .draft.active { background: var(--color-active); }
  .draft :global(svg) { flex: none; color: var(--color-accent); }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .mark { width: 8px; height: 8px; flex: none; border-radius: 50%; border: 1.5px dashed var(--color-muted-foreground); }
</style>
