<script lang="ts">
  import type { AgentLetter, AgentTranscript, SharedProjectScope, SharedProjectThread } from '@boite/contracts';
  import { untrack } from 'svelte';
  import type { Store } from '../../lib/store.svelte';
  import { errorText } from '../../lib/errors';
  import { secureId } from '../../lib/secure-id';
  import { fill, strings } from '../../lib/strings';
  import SharedDialog from './SharedDialog.svelte';
  let { store, scope, target, onclose }: { store: Store; scope: SharedProjectScope; target: SharedProjectThread; onclose: () => void } = $props();
  let view = $derived(store.shared.view(scope));
  let current = $derived(view?.project?.shared.state === 'active' ? view.threads.find(row => store.shared.threadKey(row.ref) === store.shared.threadKey(target.ref)) : undefined);
  let canRead = $derived(current?.readThreads === true);
  let transcript = $state<AgentTranscript | null>(null);
  let text = $state('');
  let error = $state('');
  let busy = $state(false);
  let sent = $state<AgentLetter | null>(null);
  let retry: {text: string; requestId: string} | undefined;
  let epoch = 0;
  $effect(() => { const captured = scope; return untrack(() => store.shared.watch(captured, ['threads'])); });
  $effect(() => {
    const allowed = canRead;
    epoch++;
    transcript = null;
    if (allowed) untrack(() => { void read(); });
  });
  $effect(() => () => { epoch++; });
  async function read(older = false) {
    if (!current?.readThreads || busy) return;
    const generation = epoch;
    busy = true; error = '';
    try {
      const page = await store.shared.read({...scope, target: target.ref, limit: 30, ...(older && transcript?.entries[0] ? {before: transcript.entries[0].at} : {})});
      if (generation === epoch && current?.readThreads) transcript = older && transcript ? {...page, entries: [...page.entries, ...transcript.entries]} : page;
    } catch (e) { if (generation === epoch) error = errorText(e); }
    finally { busy = false; }
  }
  async function send() {
    const value = text.trim();
    if (!value || !current || busy) return;
    const generation = epoch;
    if (retry?.text !== value) retry = {text: value, requestId: secureId()};
    busy = true; error = ''; sent = null;
    try {
      const letter = await store.shared.sendHuman({...scope, to: target.ref.address, text: value, requestId: retry!.requestId});
      if (generation === epoch && current) { sent = letter; text = ''; retry = undefined; }
    } catch (e) { if (generation === epoch) error = errorText(e); }
    finally { busy = false; }
  }
</script>

<SharedDialog title={target.agent.title} {onclose} testid="shared-thread-dialog">
  <p class="where">{fill(strings.shared.with, {name: view?.project?.contact.name ?? ''})} · {target.machine} · {target.agent.agent ?? ''}</p>
  {#if current}
    {#if current.readThreads}
      <div class="actions"><button type="button" class="ghost small" disabled={busy} onclick={() => void read()} data-testid="shared-thread-refresh">{strings.shared.refresh}</button>
      {#if transcript?.more}<button type="button" class="ghost small" disabled={busy} onclick={() => void read(true)}>{strings.shared.more}</button>{/if}</div>
      <div class="transcript" data-testid="shared-transcript">
        {#each transcript?.entries ?? [] as entry (entry.id)}<article data-role={entry.role}><small>{entry.role === 'user' ? strings.shared.human : entry.role === 'assistant' ? strings.shared.agent : strings.shared.protection}</small><p>{entry.text}</p></article>{/each}
      </div>
    {:else}<p class="hint" data-testid="shared-no-read">{strings.shared.noRead}</p>{/if}
    <form onsubmit={event => { event.preventDefault(); void send(); }}>
      <label><span>{strings.shared.message}</span><textarea bind:value={text} rows="3" required maxlength="4000" data-testid="shared-human-message"></textarea></label>
      <p class="hint">{strings.shared.human} · {strings.shared.external}</p>
      <button type="submit" disabled={busy || !text.trim()} data-testid="shared-human-send">{strings.shared.send}</button>
    </form>
    {#if sent}<p role="status" data-testid="shared-human-status">{strings.coordination.status[sent.status]}</p>{/if}
  {:else}<p role="status">{view?.project?.shared.state === 'revoked' ? strings.shared.state.revoked : strings.shared.offline}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</SharedDialog>

<style>
  .where, .hint, small { color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; }
  .where { margin: 0 0 12px; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; }
  .transcript { display: grid; gap: 12px; max-height: 36dvh; overflow-y: auto; margin-block: 12px; }
  article { padding: 8px 12px; border-left: 2px solid var(--color-border); }
  article[data-role='user'] { background: var(--color-surface-2); }
  article p { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-sm); line-height: 1.5; }
  form { border-top: 1px solid var(--color-border); padding-top: 12px; }
  label { display: grid; gap: 8px; font-size: var(--text-sm); }
  textarea { width: 100%; resize: vertical; }
  .error { color: var(--color-danger); font-size: var(--text-sm); }
  @media (max-width: 720px) { button { min-height: var(--touch-target); } }
</style>
