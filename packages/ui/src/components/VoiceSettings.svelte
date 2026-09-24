<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { AlertTriangle, Check, Cloud, Cpu, Download, Mic, Trash2 } from '@lucide/svelte';
  import { RpcErrorCode, type SpeechConfig, type SpeechStatus } from '@boite/contracts';
  import { RpcFailure } from '../lib/client';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  let { store, readOnly = false }: { store: Store; readOnly?: boolean } = $props();
  let config = $state<SpeechConfig | null>(null);
  let status = $state<SpeechStatus | null>(null);
  let groqKey = $state(''), openrouterKey = $state('');
  let clearGroq = $state(false), clearOpenrouter = $state(false);
  let busy = $state(false), saved = $state(false), error = $state('');
  // The poll's own failure, kept apart so a status that comes back never wipes the error of an action.
  let pollError = $state('');
  // A core older than the voice engine answers MethodNotFound: say which machine to update, once.
  let unsupported = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

  const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
  const missing = (cause: unknown): boolean => cause instanceof RpcFailure && cause.code === RpcErrorCode.MethodNotFound;
  const machine = $derived(store.core?.hostname ?? strings.app.name);

  $effect(() => {
    const client = store.client;
    if (!client || store.connection !== 'ready') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A hidden window asks nothing; the check that came due meanwhile runs when it shows again.
    let due = false;
    unsupported = false;
    const refresh = async () => {
      try {
        const next = await client.call('speech.status', {});
        if (!live) return;
        status = next;
        pollError = '';
      } catch (cause) {
        if (!live) return;
        if (missing(cause)) { unsupported = true; return; }
        pollError = message(cause);
      }
      // A download reports its progress every second; otherwise a slow check keeps the state honest.
      if (live) timer = setTimeout(() => { if (document.hidden) due = true; else void refresh(); }, status?.installing ? 1000 : 5000);
    };
    const visible = () => {
      if (!live || !due || document.hidden) return;
      due = false;
      void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    if (store.owner && !readOnly) void client.call('speech.config', {}).then((value) => { if (live) config = value; }).catch((cause) => { if (live && !missing(cause)) error = message(cause); });
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  });

  function flash() {
    saved = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved = false), 2400);
  }

  /** Every choice applies at once: the engine, the provider, the fallback and the language. Keys and paths wait for their own button. */
  async function apply(patch: Partial<SpeechConfig> = {}, withSecrets = false) {
    if (!config || !store.client) return;
    const next = { ...config, ...patch };
    busy = true; saved = false; error = '';
    try {
      status = await store.client.call('speech.configure', {
        ...next,
        ...(withSecrets && (clearGroq || groqKey) ? { groqKey: clearGroq ? '' : groqKey.trim() } : {}),
        ...(withSecrets && (clearOpenrouter || openrouterKey) ? { openrouterKey: clearOpenrouter ? '' : openrouterKey.trim() } : {}),
      });
      config = next;
      if (withSecrets) { groqKey = ''; openrouterKey = ''; clearGroq = false; clearOpenrouter = false; }
      flash();
    } catch (cause) { error = message(cause); }
    finally { busy = false; }
  }

  async function manage(method: 'speech.install' | 'speech.installCancel' | 'speech.uninstall') {
    if (!store.client) return;
    busy = true; error = '';
    try { status = await store.client.call(method, {}); }
    catch (cause) { error = message(cause); }
    finally { busy = false; }
  }

  const PROVIDERS = ['groq', 'openrouter'] as const;
  const megabytes = (bytes: number): number => Math.round(bytes / 1_000_000);
  const provider = (id: SpeechConfig['apiProvider']): string => (id === 'groq' ? strings.speech.groq : strings.speech.openrouter);
  /** What the top card says: one state, one sentence, at most one action. */
  const stage = $derived.by((): 'ready' | 'downloading' | 'failed' | 'broken' | 'local' | 'api' => {
    if (!status) return 'local';
    if (status.installing) return 'downloading';
    if (status.ready) return 'ready';
    // A failed download is retried; an unreadable speech.json is repaired by saving the choices shown.
    if (status.error) return status.engine === 'local' && !status.localReady ? 'failed' : 'broken';
    return status.engine === 'local' ? 'local' : 'api';
  });
</script>

<div class="page" data-testid="voice-settings">
  <header class="top">
    <div>
      <h1>{strings.speech.heading}<InfoTip topic={strings.speech.heading} text={strings.speech.description} /></h1>
    </div>
    {#if saved}<span class="saved" role="status"><Check size={14} />{strings.speech.saved}</span>{/if}
  </header>

  {#if unsupported}
    <section class="card status bad" data-testid="voice-status" data-state="unsupported">
      <span class="badge"><AlertTriangle size={18} /></span>
      <div class="text">
        <h2>{strings.speech.unsupported.replace('{machine}', machine)}</h2>
        <p>{strings.speech.unsupportedHint}</p>
      </div>
    </section>
  {:else if !store.owner || readOnly}
    <section class="card status" data-testid="voice-status" data-state={status?.ready ? 'ready' : 'setup'}>
      <span class="badge" class:ok={status?.ready}><Mic size={18} /></span>
      <div class="text">
        <h2>{status?.ready ? strings.speech.ready : strings.speech.notReady}</h2>
        <p>{strings.speech.ownerOnly}</p>
      </div>
    </section>
  {:else if config && status}
    <section class="card status" class:bad={stage === 'failed' || stage === 'broken'} data-testid="voice-status" data-state={stage}>
      <span class="badge" class:ok={stage === 'ready'}>
        {#if stage === 'failed' || stage === 'broken'}<AlertTriangle size={18} />{:else}<Mic size={18} />{/if}
      </span>
      <div class="text">
        {#if stage === 'ready'}
          <h2>{strings.speech.statusReady}</h2>
          <p>{status.engine === 'local' ? strings.speech.statusReadyLocal : strings.speech.statusReadyApi.replace('{provider}', provider(config.apiProvider))}</p>
        {:else if stage === 'downloading'}
          <h2>{strings.speech.downloading}</h2>
          <progress value={status.downloadedBytes} max={status.totalBytes || 1}></progress>
          <p class="bytes">{megabytes(status.downloadedBytes)} / {megabytes(status.totalBytes)} MB</p>
        {:else if stage === 'failed' || stage === 'broken'}
          <h2>{stage === 'failed' ? strings.speech.statusFailed : strings.speech.statusBroken}</h2>
          <p class="reason">{status.error}</p>
        {:else if stage === 'local'}
          <h2>{strings.speech.statusSetup}</h2>
          <p>{status.canInstallRuntime ? strings.speech.statusSetupLocal : strings.speech.statusSetupModel}</p>
        {:else}
          <h2>{strings.speech.statusKey}</h2>
          <p>{strings.speech.statusKeyHint.replace('{provider}', provider(config.apiProvider))}</p>
        {/if}
      </div>
      {#if stage === 'downloading'}
        <button type="button" class="quiet" disabled={busy} data-testid="voice-install-cancel" onclick={() => void manage('speech.installCancel')}>{strings.common.cancel}</button>
      {:else if stage === 'broken'}
        <button type="button" class="primary" data-testid="voice-repair" disabled={busy} onclick={() => void apply()}>{strings.speech.repair}</button>
      {:else if stage === 'local' || stage === 'failed'}
        <button type="button" class="primary" data-testid="voice-install" disabled={busy} onclick={() => void manage('speech.install')}>
          <Download size={15} />{stage === 'failed' ? strings.speech.tryAgain : strings.speech.setUp}
        </button>
      {/if}
    </section>

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if pollError && pollError !== error}<p class="error" role="alert" data-testid="voice-poll-error">{pollError}</p>{/if}

    <h2 class="section-label">{strings.speech.engine}</h2>
    <div class="engines" role="radiogroup" aria-label={strings.speech.engine}>
      <button type="button" role="radio" class:chosen={config.engine === 'local'} aria-checked={config.engine === 'local'} data-testid="voice-local" disabled={busy} onclick={() => { if (config!.engine !== 'local') void apply({ engine: 'local' }); }}>
        <span class="engine-head"><Cpu size={18} /><span>{strings.speech.local}</span>{#if config.engine === 'local'}<Check size={15} class="tick" />{/if}</span>
        <small>{strings.speech.localHint}</small>
      </button>
      <button type="button" role="radio" class:chosen={config.engine === 'api'} aria-checked={config.engine === 'api'} data-testid="voice-api" disabled={busy} onclick={() => { if (config!.engine !== 'api') void apply({ engine: 'api' }); }}>
        <span class="engine-head"><Cloud size={18} /><span>{strings.speech.api}</span>{#if config.engine === 'api'}<Check size={15} class="tick" />{/if}</span>
        <small>{strings.speech.apiHint}</small>
      </button>
    </div>

    {#if config.engine === 'local'}
      <section class="card">
        <div class="line">
          <div class="text">
            <h3>{strings.speech.model}</h3>
            <p>{strings.speech.modelHint}</p>
          </div>
          <span class="state" class:ok={status.localReady}>{status.localReady ? strings.speech.installed : strings.speech.missing}</span>
        </div>
        {#if status.localReady && !status.installing}
          <div class="actions"><button type="button" class="quiet small" data-testid="voice-uninstall" disabled={busy} onclick={() => void manage('speech.uninstall')}><Trash2 size={14} />{strings.speech.remove}</button></div>
        {/if}
        <details class="disclosure">
          <summary>{strings.speech.advanced}</summary>
          <p>{strings.speech.pathHint}</p>
          {#if !status.canInstallRuntime}<p>{strings.speech.runtimeHint}</p>{/if}
          <label>{strings.speech.executable}<input data-testid="voice-executable" bind:value={config.executable} spellcheck="false" /></label>
          <label>{strings.speech.modelPath}<input data-testid="voice-model-path" bind:value={config.modelPath} spellcheck="false" /></label>
          <div class="actions"><button type="button" class="small" data-testid="voice-save-paths" disabled={busy} onclick={() => void apply()}>{strings.speech.savePaths}</button></div>
        </details>
      </section>
    {:else}
      <form class="card" onsubmit={(event) => { event.preventDefault(); void apply({}, true); }}>
        <div class="field">
          <span class="label">{strings.speech.provider}</span>
          <div class="segmented" role="radiogroup" aria-label={strings.speech.provider}>
            {#each PROVIDERS as id (id)}
              <button type="button" role="radio" aria-checked={config.apiProvider === id} disabled={busy} onclick={() => { if (config!.apiProvider !== id) void apply({ apiProvider: id }); }}>{provider(id)}</button>
            {/each}
          </div>
          <p>{strings.speech.groqModel}</p>
        </div>
        <label>{strings.speech.groqKey}<input type="password" autocomplete="new-password" data-testid="voice-groq-key" bind:value={groqKey} disabled={clearGroq} placeholder={status.groqKeySet ? strings.speech.keySaved : strings.speech.keyEmpty} /></label>
        {#if status.groqKeySet}<label class="check"><input type="checkbox" bind:checked={clearGroq} />{strings.speech.clearKey}</label>{/if}
        <label>{strings.speech.openrouterKey}<input type="password" autocomplete="new-password" data-testid="voice-openrouter-key" bind:value={openrouterKey} disabled={clearOpenrouter} placeholder={status.openrouterKeySet ? strings.speech.keySaved : strings.speech.keyEmpty} /></label>
        {#if status.openrouterKeySet}<label class="check"><input type="checkbox" bind:checked={clearOpenrouter} />{strings.speech.clearKey}</label>{/if}
        <div class="actions"><button type="submit" class="primary small" data-testid="voice-save" disabled={busy || (!groqKey && !openrouterKey && !clearGroq && !clearOpenrouter)}>{strings.speech.saveKeys}</button></div>
        <label class="check fallback"><input type="checkbox" checked={config.fallback} disabled={busy} onchange={(event) => void apply({ fallback: event.currentTarget.checked })} />{strings.speech.fallback}</label>
        <p>{strings.speech.fallbackHint}</p>
      </form>
    {/if}

    <section class="card">
      <label>{strings.speech.language}<input class="language" data-testid="voice-language" maxlength="2" pattern={'[a-z]{2}|'} value={config.language} placeholder="auto" aria-describedby="voice-language-hint"
        onchange={(event) => { const value = event.currentTarget.value.trim().toLowerCase(); if (value !== config!.language && /^([a-z]{2})?$/.test(value)) void apply({ language: value }); }} /></label>
      <p id="voice-language-hint">{strings.speech.languageHint}</p>
    </section>
  {/if}
  <footer><p>{strings.speech.privacy}</p><p>{strings.speech.limit}</p></footer>
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 14px; }
  .page > :global(*) { width: 100%; max-width: 880px; }
  :global(.settings) .page > header.top { margin-bottom: 10px; }
  .page > .card, .page .card { max-width: 880px; margin: 0; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  p, small { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.55; margin: 0; }
  h2.section-label { margin: 10px 0 -4px; }
  h3 { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--color-foreground); }

  /* The one card that answers "can I dictate now", with the single action that gets there. */
  .page .status { flex-direction: row; align-items: center; gap: 16px; padding: 20px; }
  .status .text { flex: 1; min-width: 0; display: grid; gap: 4px; }
  .page .card.status h2 { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--color-foreground); text-transform: none; letter-spacing: normal; }
  .badge { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: 50%; color: var(--color-muted-foreground); background: var(--color-surface-3); }
  .badge.ok { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 14%, transparent); }
  .status.bad .badge { color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 14%, transparent); }
  .status > button { flex: none; }
  .reason { color: var(--color-danger); overflow-wrap: anywhere; }
  progress { width: 100%; height: 6px; margin-top: 6px; accent-color: var(--color-accent); }
  .bytes { font-variant-numeric: tabular-nums; }

  .engines { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .engines button { height: auto; min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: 8px; padding: 16px; text-align: left; white-space: normal; font-weight: normal; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: none; }
  .engines button:hover:not(:disabled) { background: var(--color-hover); }
  .engines button.chosen { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .engines button:disabled { opacity: 1; }
  .engine-head { display: flex; align-items: center; gap: 10px; font-size: var(--text-base); font-weight: 600; color: var(--color-foreground); }
  .engine-head :global(.tick) { margin-left: auto; color: var(--color-accent); }

  .line { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .line .text { display: grid; gap: 4px; min-width: 0; }
  .state { flex: none; font-size: var(--text-sm); color: var(--color-subtle); }
  .state.ok, .saved { color: var(--color-success); }
  .saved { display: inline-flex; gap: 6px; align-items: center; font-size: var(--text-sm); white-space: nowrap; }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .field { display: grid; gap: 8px; }
  .label { font-size: var(--text-sm); }
  label { display: flex; flex-direction: column; gap: 7px; font-size: var(--text-sm); }
  input { width: 100%; }
  .language { max-width: 120px; }
  .check { flex-direction: row; align-items: center; }
  .check input { width: 16px; flex: none; }
  .fallback { padding-top: 12px; border-top: 1px solid var(--color-border); }
  details { border-top: 1px solid var(--color-border); padding-top: 12px; display: grid; gap: 12px; }
  summary { cursor: pointer; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .segmented { display: flex; gap: 4px; }
  .segmented button[aria-checked='true'] { background: var(--color-active); }
  .error { color: var(--color-danger); overflow-wrap: anywhere; }
  footer { display: grid; gap: 8px; margin-top: 6px; }
  @media (max-width: 720px) {
    .engines { grid-template-columns: 1fr; }
    .page .status { flex-wrap: wrap; padding: 16px; }
    .status > button { flex-basis: 100%; min-height: var(--touch-target); }
    .page > .card, .page .card { padding: 16px; }
    .actions button { min-height: var(--touch-target); }
  }
</style>
