<script lang="ts">
  import type { ThreadSummary } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  let { store, thread }: { store: Store; thread: ThreadSummary } = $props();
  let summary = $state('');
  let pending = $state(false);
  let sent = $state(false);
  let open = $state(false);
  let attempt: { text: string; id: string } | null = null;
  const source = $derived(store.threads.find(item => item.id === thread.forkOrigin?.threadId));
  const unavailable = $derived(store.connection !== 'ready' || thread.archived || !source || source.archived);
  async function submit() {
    if (pending || unavailable || !summary.trim() || summary.length > 4000) return;
    if (attempt?.text !== summary) attempt = { text: summary, id: crypto.randomUUID() };
    pending = true;
    try {
      const receipt = await store.mergeBack(thread.id, attempt.text, attempt.id);
      if (receipt) { sent = true; open = false; summary = ''; attempt = null; }
    } finally { pending = false; }
  }
</script>

{#if thread.forkOrigin}
  <section class="fork" data-testid="fork-return" aria-label={strings.chat.forkOrigin}>
    <div class="origin"><span>{strings.chat.forkOrigin}</span><button type="button" class="ghost" disabled={!source || source.archived} onclick={() => void store.open(thread.forkOrigin!.threadId)}>{source?.title ?? strings.chat.forkSourceUnavailable}</button></div>
    <small>{thread.forkOrigin.mode === 'native' ? strings.chat.forkNative : strings.chat.forkSeeded}</small>
    <details bind:open>
      <summary>{strings.chat.forkReturn}</summary>
      <form onsubmit={event => { event.preventDefault(); void submit(); }}>
        <label for="fork-summary">{strings.chat.forkSummary}</label>
        <textarea id="fork-summary" bind:value={summary} disabled={pending || unavailable} maxlength="4000" rows="3" data-testid="fork-return-text"></textarea>
        <div class="actions"><small>{summary.length}/4000</small><button type="submit" disabled={pending || unavailable || !summary.trim()} data-testid="fork-return-send">{pending ? strings.app.loading : strings.chat.forkReturn}</button></div>
      </form>
    </details>
    {#if sent}<p role="status">{strings.chat.forkReturned}</p>{/if}
  </section>
{/if}

<style>
  .fork { flex: none; max-height: 40%; overflow: auto; border-bottom: 1px solid var(--color-border); padding: 8px 20px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .origin { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
  .origin button { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: inherit; }
  summary { cursor: pointer; min-height: 32px; padding: 8px 0; }
  form { max-width: var(--content); margin-top: 4px; }
  label { display: block; margin-bottom: 6px; }
  textarea { width: 100%; resize: vertical; min-height: 80px; font: inherit; }
  .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 6px 0; }
  p { margin: 4px 0; color: var(--color-success); }
  @media (max-width: 720px) { .fork { padding: 4px 10px; } summary, button { min-height: var(--touch-target); } }
</style>
