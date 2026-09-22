<script lang="ts">
  import { onMount } from 'svelte';
  import type { BrowserStatus, BrowserTask } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings, fill } from '../lib/strings';

  let { store, pluginId }: { store: Store; pluginId: string } = $props();
  const t = strings.plugins;
  let status = $state<BrowserStatus | null>(null);
  let enabled = $state(false);
  let executable = $state('');
  let busy = $state(false);
  let error = $state('');
  let saved = $state(false);
  let tasks = $derived(status?.tasks.filter(task => task.pluginId === pluginId).slice(0, 8) ?? []);
  onMount(() => {
    const client = store.client;
    if (!client) return;
    let disposed = false;
    const early = new Map<string, BrowserTask>();
    const merge = (tasks: BrowserTask[], task: BrowserTask) => [task, ...tasks.filter(row => row.id !== task.id)];
    const off = client.on('browser.updated', task => {
      if (status) status = { ...status, tasks: merge(status.tasks, task) };
      else early.set(task.id, task);
    });
    void client.call('browser.status', {}).then(value => {
      if (disposed) return;
      status = { ...value, tasks: [...early.values()].reduce(merge, value.tasks) };
      early.clear(); enabled = value.config.enabled; executable = value.config.executablePath ?? '';
    }).catch(cause => { if (!disposed) error = String(cause.message ?? cause); });
    return () => { disposed = true; off(); };
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    const client = store.client;
    if (!client || busy) return;
    busy = true; error = ''; saved = false;
    try { status = await client.call('browser.configure', { enabled, executablePath: executable.trim() || null }); saved = true; }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  async function cancel(task: BrowserTask) {
    const client = store.client;
    if (!client || busy) return;
    busy = true; error = '';
    try {
      const next = await client.call('browser.cancel', { threadId: task.threadId, id: task.id });
      if (status) status = { ...status, tasks: status.tasks.map(row => row.id === next.id ? next : row) };
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
</script>

<section aria-label={t.browserTitle} data-testid="browser-plugin">
  <p class="hint">{t.browserHint}</p>
  {#if status}
    <form onsubmit={save}>
      <label class="enable"><input type="checkbox" bind:checked={enabled} disabled={busy} data-testid="browser-enabled" />{t.browserEnabled}</label>
      <label class="path">{t.browserExecutable}<input bind:value={executable} disabled={busy} spellcheck="false" autocomplete="off" placeholder={t.browserExecutableHint} data-testid="browser-executable" /></label>
      <p class="hint" data-testid="browser-key">{status.keyAvailable ? t.browserKeyReady : t.browserKeyMissing}</p>
      <div class="actions"><button class="small" type="submit" disabled={busy} data-testid="browser-save">{t.browserSave}</button>{#if saved}<span class="hint" role="status">{t.browserSaved}</span>{/if}</div>
    </form>
    <h4 class="section-label">{t.browserTasks}</h4>
    {#each tasks as task (task.id)}
      <article data-testid="browser-task" data-status={task.status}>
        <div class="task-head"><span class="goal">{task.goal}</span><span class="state">{t.browserStatus[task.status]}</span></div>
        <p class="hint">{task.message}</p>
        <div class="actions"><span class="hint">{fill(t.browserProgress, { step: String(task.step), max: String(task.maxSteps), tokens: String(task.inputTokens) })}</span>
          {#if task.finishedAt === null}<button class="quiet small" disabled={busy} onclick={() => void cancel(task)} data-testid="browser-cancel">{strings.common.cancel}</button>{/if}
        </div>
      </article>
    {:else}<p class="hint">{t.browserEmpty}</p>{/each}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  section { display: grid; gap: 12px; border-top: 1px solid var(--color-border); padding-top: 12px; min-width: 0; }
  form { display: grid; gap: 10px; }
  .hint { margin: 0; font-size: var(--text-sm); line-height: 1.5; color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  .enable { display: flex; align-items: center; gap: 8px; min-height: var(--control); font-size: var(--text-sm); }
  .enable input { flex: none; width: 16px; height: 16px; accent-color: var(--color-foreground); }
  .path { display: grid; gap: 6px; font-size: var(--text-sm); }
  .path input { width: 100%; min-width: 0; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  h4 { margin: 8px 0 0; }
  article { display: grid; gap: 6px; padding: 10px 12px; background: var(--color-surface-2); border-radius: var(--radius-md); }
  .task-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; font-size: var(--text-sm); }
  .goal { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .state { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .error { color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; margin: 0; }
</style>
