<script lang="ts">
  import { Check, Copy, Download, FolderDown, NotebookPen } from '@lucide/svelte';
  import { planFileName } from '../lib/plan';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import Prose from './Prose.svelte';

  /**
   * The plan an agent proposes before it edits, read as a document rather than
   * a tool's JSON: copy it, download it as markdown, or write it into the
   * thread's folder. Writing is the editor's save, so only the owner gets it.
   */
  let { store, threadId, plan }: { store: Store; threadId: string; plan: string } = $props();

  let copied = $state(false);
  let saving = $state(false);
  let saved = $state<string | null>(null);
  let reset = 0;
  $effect(() => () => clearTimeout(reset));

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(plan);
    } catch {
      return;
    }
    copied = true;
    clearTimeout(reset);
    reset = window.setTimeout(() => { copied = false; }, 1500);
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([plan], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = planFileName(plan);
    link.click();
    // Firefox and Safari start the download after this task, so the URL lives a second.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function save(): Promise<void> {
    const client = store.client;
    if (!client || saving) return;
    saving = true;
    try {
      const names = (await client.call('files.list', { threadId })).map((entry) => entry.name);
      const name = planFileName(plan, names);
      await client.call('files.write', { threadId, path: name, text: plan });
      saved = name;
    } catch (error) {
      store.error = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
    }
  }
</script>

<section class="plan" data-testid="plan-card">
  <div class="head">
    <NotebookPen size={15} strokeWidth={1.75} />
    <span class="title ui-label">{strings.chat.plan}</span>
  </div>
  <div class="body"><Prose text={plan} {store} {threadId} /></div>
  <div class="actions">
    <button type="button" class="ghost small" data-testid="plan-copy" onclick={() => void copy()}>
      {#if copied}<Check size={14} /><span class="ui-label">{strings.chat.copied}</span>{:else}<Copy size={14} /><span class="ui-label">{strings.chat.copy}</span>{/if}
    </button>
    <button type="button" class="ghost small" data-testid="plan-download" onclick={download}>
      <Download size={14} /><span class="ui-label">{strings.chat.planDownload}</span>
    </button>
    {#if store.owner}
      <button type="button" class="ghost small" data-testid="plan-save" disabled={saving || saved !== null || store.connection !== 'ready'}
        title={saved ? fill(strings.chat.planSaved, { name: saved }) : strings.chat.planSaveHint} onclick={() => void save()}>
        {#if saved}<Check size={14} /><span class="saved ui-label">{fill(strings.chat.planSaved, { name: saved })}</span>{:else}<FolderDown size={14} /><span class="ui-label">{strings.chat.planSave}</span>{/if}
      </button>
    {/if}
  </div>
</section>

<style>
  .plan {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-muted-foreground);
  }

  .title {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .body {
    padding: 4px 12px;
    min-width: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-top: 1px solid var(--color-border);
  }

  .actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .saved {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .actions button { min-height: var(--touch-target); }
  }
</style>
