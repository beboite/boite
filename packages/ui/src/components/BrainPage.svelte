<script lang="ts">
  import { ArrowUp, Brain, Folder, RefreshCw } from '@lucide/svelte';
  import { RpcErrorCode, type BrainStatus, type RpcResult } from '@boite/contracts';
  import { RpcFailure } from '../lib/client';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';

  let { store }: { store: Store } = $props();
  let status = $state.raw<BrainStatus | null>(null);
  let path = $state('');
  let enabled = $state(true);
  let busy = $state(false);
  let error = $state('');
  let folders = $state.raw<RpcResult<'projects.browse'> | null>(null);
  let revision = 0;
  const t = strings.brain;
  const kinds = ['instructions', 'skill', 'plugin'] as const;
  const failure = (cause: unknown) => cause instanceof RpcFailure && cause.code === RpcErrorCode.MethodNotFound ? t.missing : cause instanceof Error ? cause.message : String(cause);

  $effect(() => {
    const client = store.client;
    if (!client || !store.owner || store.connection !== 'ready') return;
    const current = ++revision;
    status = null; error = ''; folders = null; busy = true;
    void client.call('brain.status', {}).then(next => {
      if (current !== revision) return;
      status = next; path = next.config.path ?? ''; enabled = next.config.path ? next.config.enabled : true;
    }).catch(cause => { if (current === revision) error = failure(cause); })
      .finally(() => { if (current === revision) busy = false; });
    return () => { ++revision; };
  });

  async function run(action: 'save' | 'refresh' | 'sync' | 'disconnect') {
    const client = store.client;
    if (!client || busy) return;
    const current = revision;
    busy = true; error = '';
    try {
      const next = action === 'save' || action === 'disconnect'
        ? await client.call('brain.configure', { path: action === 'disconnect' ? null : path.trim(), enabled: action === 'disconnect' ? false : enabled })
        : action === 'sync' ? await client.call('brain.sync', {}) : await client.call('brain.status', {});
      if (current !== revision) return;
      status = next;
      if (action === 'save' || action === 'disconnect') { path = next.config.path ?? ''; enabled = next.config.enabled; folders = null; }
    } catch (cause) { if (current === revision) error = failure(cause); }
    finally { if (current === revision) busy = false; }
  }

  async function browse(target?: string) {
    const client = store.client;
    if (!client || busy) return;
    const current = revision;
    busy = true; error = '';
    try {
      const next = await client.call('projects.browse', target ? { path: target } : {});
      if (current === revision) folders = next;
    } catch (cause) { if (current === revision) error = failure(cause); }
    finally { if (current === revision) busy = false; }
  }
</script>

<div class="page" data-testid="brain-page" aria-busy={busy}>
  <header><div><h1><Brain size={22} />{t.heading}</h1><p>{t.description}</p><p class="machine">{store.core?.hostname ?? store.endpointUrl}</p></div></header>
  {#if error}<p class="error" role="alert" data-testid="brain-error">{error}</p>{/if}
  <form class="card" onsubmit={event => { event.preventDefault(); void run('save'); }}>
    <label for="brain-path">{t.folder}</label>
    <div class="path-row"><input id="brain-path" data-testid="brain-path" bind:value={path} placeholder={t.pathHint} disabled={busy} /><button type="button" disabled={busy} onclick={() => void browse(path || undefined)}>{t.browse}</button></div>
    {#if folders}
      <div class="folders" data-testid="brain-folders">
        <code>{folders.path}</code>
        {#if folders.parent}<button type="button" class="ghost" disabled={busy} onclick={() => void browse(folders!.parent!)}><ArrowUp size={15} />{strings.connection.parent}</button>{/if}
        {#each folders.directories as directory (directory.path)}<button type="button" class="ghost folder" disabled={busy} onclick={() => void browse(directory.path)}><Folder size={15} />{directory.name}</button>{/each}
        <button type="button" disabled={busy} onclick={() => { path = folders!.path; folders = null; }}>{t.useFolder}</button>
      </div>
    {/if}
    <label class="switch-row"><span class="text">{t.enabled}<span class="hint">{t.enabledHint}</span></span><input type="checkbox" role="switch" bind:checked={enabled} disabled={busy} data-testid="brain-enabled" /></label>
    <div class="actions"><button class="primary" type="submit" disabled={busy || !path.trim()} data-testid="brain-save">{t.save}</button>{#if status?.config.path}<button type="button" class="ghost" disabled={busy} onclick={() => void run('disconnect')} data-testid="brain-disconnect">{t.disconnect}</button>{/if}</div>
  </form>
  {#if status?.config.path}
    <section class="card" data-testid="brain-sync-card">
      <div class="heading"><h2>{t.sync}</h2><button disabled={busy} onclick={() => void run('refresh')} aria-label={t.refresh} data-testid="brain-refresh"><RefreshCw size={15} /></button></div>
      <code>{status.config.path}</code>
      {#if status.git}
        <p>{status.git.branch ?? t.noUpstream}{#if status.git.upstream} · {status.git.upstream}{/if}</p>
        <p>{t.counts.replace('{ahead}', String(status.git.ahead)).replace('{behind}', String(status.git.behind))}</p>
        {#if status.git.dirty}<p class="warning">{t.dirty}</p>{/if}
        {#if !status.git.upstream}<p>{t.noUpstream}</p>{/if}
      {:else}<p>{t.noGit}</p>{/if}
      <p>{t.syncHint}</p>
      <div class="actions"><button disabled={busy || !status.git?.upstream || status.git.dirty} onclick={() => void run('sync')} data-testid="brain-sync">{busy ? t.working : t.sync}</button><small role="status" data-testid="brain-last-sync">{status.lastSync ? `${t.lastSync} ${new Date(status.lastSync).toLocaleString()}` : t.never}</small></div>
    </section>
    <section class="card" data-testid="brain-inventory">
      <h2>{t.detected}</h2>
      {#each status.problems as problem, index (`${index}:${problem}`)}<p class="error">{problem}</p>{/each}
      {#each kinds as kind (kind)}
        {@const entries = status.entries.filter(entry => entry.kind === kind)}
        {#if entries.length}
          <h3>{t[kind]} <span>{entries.length}</span></h3>
          {#each entries as entry (entry.path)}
            <div class="entry" data-testid="brain-entry"><strong>{entry.name}</strong>{#if entry.description}<p>{entry.description}</p>{/if}<code>{entry.path}</code>{#if entry.error}<p class="error">{entry.error}</p>{/if}</div>
          {/each}
        {/if}
      {/each}
      {#if !status.entries.length}<p>{t.noEntries}</p>{/if}
      <p>{t.pluginHint}</p>
    </section>
  {:else if status}<p>{t.empty}</p>{/if}
</div>

<style>
  .page { max-width: 880px; width: 100%; padding: 32px; }
  h1 { font-size: var(--text-lg); display: flex; align-items: center; gap: 10px; margin: 0; }
  h2 { font-size: var(--text-md); margin: 0; }
  h3 { font-size: var(--text-sm); margin: 18px 0 8px; }
  h3 span { color: var(--color-muted-foreground); margin-left: 6px; }
  p, small { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.5; }
  p { margin: 8px 0; }
  .card { padding: 20px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-e1); min-width: 0; }
  label { font-size: var(--text-sm); }
  .path-row { display: flex; gap: 8px; margin: 8px 0 18px; }
  .path-row input { flex: 1; min-width: 0; }
  .actions, .heading { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .heading { justify-content: space-between; margin-bottom: 12px; }
  .entry { padding: 12px 0; border-top: 1px solid var(--color-border); }
  strong { font-size: var(--text-sm); font-weight: 500; }
  code { display: block; font-size: var(--text-sm); color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }
  .warning { color: var(--color-live); }
  .machine { overflow-wrap: anywhere; }
  .folders { display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow-y: auto; padding: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .folder { justify-content: flex-start; flex-shrink: 0; }
  @media (max-width: 720px) { .page { padding: 16px; } .card { padding: 16px; } .path-row { flex-wrap: wrap; } .path-row input { flex-basis: 100%; } }
</style>
