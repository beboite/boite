<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import VoiceInputSettings from './VoiceInputSettings.svelte';
  import { AlertTriangle, Check, Download, LoaderCircle, Trash2 } from '@lucide/svelte';
  import { RpcErrorCode, type SpeechConfig, type SpeechModel, type SpeechStatus } from '@boite/contracts';
  import { RpcFailure } from '../lib/client';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  let { store, readOnly = false }: { store: Store; readOnly?: boolean } = $props();
  let config = $state<SpeechConfig | null>(null);
  let status = $state<SpeechStatus | null>(null);
  let groqKey = $state(''), openrouterKey = $state('');
  let link = $state('');
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
        // A finished download makes its model the one in use: read the choice again.
        const finished = status?.installing && !next.installing;
        status = next;
        pollError = '';
        if (finished && config) config = await client.call('speech.config', {});
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

  /** Every choice applies at once. Typed keys and paths wait for their own button. */
  async function apply(patch: Partial<SpeechConfig> = {}, keys: { groqKey?: string; openrouterKey?: string } = {}) {
    if (!config || !store.client) return;
    const next = { ...config, ...patch };
    busy = true; saved = false; error = '';
    try {
      status = await store.client.call('speech.configure', { ...next, ...keys });
      config = next;
      if (keys.groqKey !== undefined) groqKey = '';
      if (keys.openrouterKey !== undefined) openrouterKey = '';
      flash();
    } catch (cause) { error = message(cause); }
    finally { busy = false; }
  }

  async function manage<M extends 'speech.install' | 'speech.installCancel' | 'speech.uninstall'>(method: M, params: { model?: string; url?: string } = {}): Promise<boolean> {
    if (!store.client) return false;
    busy = true; error = '';
    try {
      status = await store.client.call(method, params as never);
      // A finished pick or a removal can change the model in use.
      if (config && method !== 'speech.installCancel') config = await store.client.call('speech.config', {});
      return true;
    } catch (cause) { error = message(cause); return false; }
    finally { busy = false; }
  }

  /** A model already here is used at once; one that is not downloads, then takes over. */
  function pick(model: SpeechModel) {
    if (model.installed) { if (active !== model.id) void apply({ model: model.id, modelPath: '' }); }
    else void manage('speech.install', { model: model.id });
  }

  async function addLink(event: SubmitEvent) {
    event.preventDefault();
    const url = link.trim();
    if (url && await manage('speech.install', { url })) link = '';
  }

  function saveKeys(event: SubmitEvent) {
    event.preventDefault();
    void apply({}, { ...(groqKey.trim() ? { groqKey: groqKey.trim() } : {}), ...(openrouterKey.trim() ? { openrouterKey: openrouterKey.trim() } : {}) });
  }

  const PROVIDERS = ['groq', 'openrouter'] as const;
  const megabytes = (bytes: number): number => Math.round(bytes / 1_000_000);
  const provider = (id: SpeechConfig['apiProvider']): string => (id === 'groq' ? strings.speech.groq : strings.speech.openrouter);
  /** A path set by hand wins over the list, so no row is the one in use. */
  const active = $derived(config && !config.modelPath ? config.model : null);
  const current = $derived(status?.models.find((model) => model.id === config?.model));
  const fetching = $derived(status?.models.find((model) => model.id === status?.downloading));
  const modelName = $derived(config?.modelPath ? config.modelPath.split(/[\\/]/).at(-1) ?? '' : current?.name ?? config?.model ?? '');
  const meta = (model: SpeechModel): string => [
    model.bytes ? `${megabytes(model.bytes)} ${strings.units.megabytes}` : '',
    model.tier ? strings.speech.tiers[model.tier] : model.host ?? '',
  ].filter(Boolean).join(' · ');
  /** What the top line says: one state, at most one action. */
  const stage = $derived.by((): 'ready' | 'downloading' | 'failed' | 'broken' | 'local' | 'api' => {
    if (!status) return 'local';
    if (status.installing) return 'downloading';
    if (status.ready) return 'ready';
    // A failed download is retried; an unreadable speech.json is repaired by saving the choices shown.
    if (status.error) return status.engine === 'local' && !status.localReady ? 'failed' : 'broken';
    return status.engine === 'local' ? 'local' : 'api';
  });
  const tone = $derived(stage === 'ready' ? 'ok' : stage === 'failed' || stage === 'broken' ? 'bad' : stage === 'downloading' ? 'busy' : '');
</script>

<div class="page" data-testid="voice-settings">
  <header>
    <h1>{strings.speech.heading}<InfoTip topic={strings.speech.heading} text={strings.speech.description} /></h1>
    {#if saved}<span class="saved" role="status"><Check size={14} /><span class="ui-label">{strings.speech.saved}</span></span>{/if}
  </header>

  <VoiceInputSettings />

  {#if unsupported}
    <section class="card status" data-testid="voice-status" data-state="unsupported">
      <div class="status-line">
        <AlertTriangle size={16} class="alert" />
        <div class="text">{strings.speech.unsupported.replace('{machine}', machine)}<span class="hint">{strings.speech.unsupportedHint}</span></div>
      </div>
    </section>
  {:else if !store.owner || readOnly}
    <section class="card status" data-testid="voice-status" data-state={status?.ready ? 'ready' : 'setup'}>
      <div class="status-line">
        <span class="dot" class:ok={status?.ready}></span>
        <div class="text">{status?.ready ? strings.speech.ready : strings.speech.notReady}<span class="hint">{strings.speech.ownerOnly}</span></div>
      </div>
    </section>
  {:else if config && status}
    <section class="card status" data-testid="voice-status" data-state={stage}>
      <div class="status-line">
        {#if tone === 'bad'}<AlertTriangle size={16} class="alert" />{:else}<span class="dot {tone}"></span>{/if}
        <div class="text">
          {#if stage === 'ready'}
            {status.engine === 'local' ? fill(strings.speech.readyLocal, { model: modelName }) : fill(strings.speech.readyApi, { provider: provider(config.apiProvider) })}
            {#if status.engine === 'local' && status.runtimeOutdated}<span class="hint">{strings.speech.updateHint}</span>{/if}
          {:else if stage === 'downloading'}
            {fill(strings.speech.downloadingModel, { model: fetching?.name ?? '' })}
            <span class="hint bytes">{megabytes(status.downloadedBytes)}{status.totalBytes ? ` / ${megabytes(status.totalBytes)}` : ''} {strings.units.megabytes}</span>
          {:else if stage === 'failed' || stage === 'broken'}
            {stage === 'failed' ? strings.speech.statusFailed : strings.speech.statusBroken}
            <span class="hint reason">{status.error}</span>
          {:else if stage === 'local'}
            {strings.speech.notSetUp}
            {#if !status.canInstallRuntime}<span class="hint">{strings.speech.needsCli}</span>{:else if current}<span class="hint">{meta(current) ? `${current.name}, ${meta(current)}` : current.name}</span>{/if}
          {:else}
            {fill(strings.speech.statusKey, { provider: provider(config.apiProvider) })}
          {/if}
        </div>
        {#if stage === 'downloading'}
          <button type="button" class="quiet small" disabled={busy} data-testid="voice-install-cancel" onclick={() => void manage('speech.installCancel')}><span class="ui-label">{strings.common.cancel}</span></button>
        {:else if stage === 'broken'}
          <button type="button" class="primary small" data-testid="voice-repair" disabled={busy} onclick={() => void apply()}><span class="ui-label">{strings.speech.repair}</span></button>
        {:else if stage === 'local' || stage === 'failed'}
          <button type="button" class="primary small" data-testid="voice-install" disabled={busy} onclick={() => void manage('speech.install')}>
            <Download size={14} /><span class="ui-label">{stage === 'failed' ? strings.speech.tryAgain : strings.speech.setUp}</span>
          </button>
        {:else if stage === 'ready' && status.engine === 'local' && status.runtimeOutdated}
          <button type="button" class="small" data-testid="voice-update" disabled={busy} onclick={() => void manage('speech.install')}><span class="ui-label">{strings.speech.update}</span></button>
        {/if}
      </div>
      {#if stage === 'downloading'}<progress value={status.downloadedBytes} max={status.totalBytes || undefined}></progress>{/if}
    </section>

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <!-- A link or model that failed while another model stays ready: the top line says ready, the reason goes here. -->
    {#if status.error && stage !== 'failed' && stage !== 'broken' && status.error !== error}<p class="error" role="alert" data-testid="voice-download-error">{status.error}</p>{/if}
    {#if pollError && pollError !== error}<p class="error" role="alert" data-testid="voice-poll-error">{pollError}</p>{/if}

    <section class="card">
      <div class="switch-row">
        <span class="text">{strings.speech.engine}<InfoTip topic={strings.speech.engine} text={strings.speech.engineHint} /></span>
        <div class="segmented" role="radiogroup" aria-label={strings.speech.engine}>
          <button type="button" role="radio" class:on={config.engine === 'local'} aria-checked={config.engine === 'local'} data-testid="voice-local" disabled={busy} onclick={() => { if (config!.engine !== 'local') void apply({ engine: 'local' }); }}><span class="ui-label">{strings.speech.local}</span></button>
          <button type="button" role="radio" class:on={config.engine === 'api'} aria-checked={config.engine === 'api'} data-testid="voice-api" disabled={busy} onclick={() => { if (config!.engine !== 'api') void apply({ engine: 'api' }); }}><span class="ui-label">{strings.speech.api}</span></button>
        </div>
      </div>
      <div class="switch-row">
        <span class="text" id="voice-language-label">{strings.speech.language}<InfoTip topic={strings.speech.language} text={strings.speech.languageHint} /></span>
        <input class="language" data-testid="voice-language" maxlength="2" pattern={'[a-z]{2}|'} value={config.language} placeholder="auto" aria-labelledby="voice-language-label" spellcheck="false"
          onchange={(event) => { const value = event.currentTarget.value.trim().toLowerCase(); if (value !== config!.language && /^([a-z]{2})?$/.test(value)) void apply({ language: value }); }} />
      </div>
    </section>

    {#if config.engine === 'local'}
      <section class="card" data-testid="voice-models">
        {#if status.models}
        <h2>{strings.speech.model}<InfoTip topic={strings.speech.model} text={strings.speech.modelHint} /></h2>
        <div class="models" role="radiogroup" aria-label={strings.speech.model}>
          {#each status.models as model (model.id)}
            <div class="switch-row model" data-testid="voice-model-{model.id}">
              <button type="button" role="radio" class="pick" aria-checked={active === model.id} disabled={busy || status.downloading === model.id} onclick={() => pick(model)}>
                <span class="radio" aria-hidden="true"></span>
                <span class="text">{model.name}<span class="hint">{meta(model)}</span></span>
              </button>
              {#if status.downloading === model.id}
                <LoaderCircle size={16} class="spinner" aria-label={strings.speech.downloading} />
              {:else if model.installed}
                <button type="button" class="icon ghost" title={fill(strings.speech.remove, { model: model.name })} aria-label={fill(strings.speech.remove, { model: model.name })} data-testid="voice-model-remove-{model.id}" disabled={busy} onclick={() => void manage('speech.uninstall', { model: model.id })}><Trash2 size={15} /></button>
              {:else}
                <button type="button" class="quiet small" data-testid="voice-model-download-{model.id}" disabled={busy || status.installing} onclick={() => void manage('speech.install', { model: model.id })}><Download size={14} /><span class="ui-label">{strings.speech.download}</span></button>
              {/if}
            </div>
          {/each}
        </div>
        <form class="switch-row link" onsubmit={addLink}>
          <span class="text" id="voice-link-label">{strings.speech.link}<InfoTip topic={strings.speech.link} text={strings.speech.linkHint} /></span>
          <div class="field">
            <input type="url" inputmode="url" spellcheck="false" autocomplete="off" data-testid="voice-model-url" aria-labelledby="voice-link-label" placeholder={strings.speech.linkPlaceholder} bind:value={link} />
            <button type="submit" class="small" data-testid="voice-model-add" disabled={busy || status.installing || !link.trim()}><span class="ui-label">{strings.speech.add}</span></button>
          </div>
        </form>
        {/if}
        <details class="disclosure">
          <summary><span class="ui-label">{strings.speech.advanced}</span></summary>
          <div class="paths">
            <label>{strings.speech.executable}<input data-testid="voice-executable" bind:value={config.executable} spellcheck="false" placeholder={status.canInstallRuntime ? '' : 'whisper-cli'} /></label>
            <label>{strings.speech.modelPath}<input data-testid="voice-model-path" bind:value={config.modelPath} spellcheck="false" /></label>
            <div class="actions">
              <button type="button" class="small" data-testid="voice-save-paths" disabled={busy} onclick={() => void apply()}><span class="ui-label">{strings.speech.savePaths}</span></button>
              <InfoTip topic={strings.speech.advanced} text={strings.speech.pathHint} />
            </div>
          </div>
        </details>
      </section>
    {:else}
      <form class="card" onsubmit={saveKeys}>
        <div class="switch-row">
          <span class="text">{strings.speech.provider}<InfoTip topic={strings.speech.provider} text={strings.speech.providerHint} /></span>
          <div class="segmented" role="radiogroup" aria-label={strings.speech.provider}>
            {#each PROVIDERS as id (id)}
              <button type="button" role="radio" class:on={config.apiProvider === id} aria-checked={config.apiProvider === id} data-testid="voice-provider-{id}" disabled={busy} onclick={() => { if (config!.apiProvider !== id) void apply({ apiProvider: id }); }}><span class="ui-label">{provider(id)}</span></button>
            {/each}
          </div>
        </div>
        {#each PROVIDERS as id (id)}
          {@const set = id === 'groq' ? status.groqKeySet : status.openrouterKeySet}
          <div class="switch-row key">
            <span class="text" id="voice-{id}-label">{id === 'groq' ? strings.speech.groqKey : strings.speech.openrouterKey}{#if set}<span class="hint ok">{strings.speech.keySaved}</span>{/if}</span>
            <div class="field">
              {#if id === 'groq'}
                <input type="password" autocomplete="new-password" data-testid="voice-groq-key" aria-labelledby="voice-groq-label" bind:value={groqKey} placeholder={set ? strings.speech.keyReplace : strings.speech.keyEmpty} />
              {:else}
                <input type="password" autocomplete="new-password" data-testid="voice-openrouter-key" aria-labelledby="voice-openrouter-label" bind:value={openrouterKey} placeholder={set ? strings.speech.keyReplace : strings.speech.keyEmpty} />
              {/if}
              {#if set}<button type="button" class="quiet small" data-testid="voice-{id}-remove" disabled={busy} onclick={() => void apply({}, id === 'groq' ? { groqKey: '' } : { openrouterKey: '' })}><span class="ui-label">{strings.speech.removeKey}</span></button>{/if}
            </div>
          </div>
        {/each}
        {#if groqKey.trim() || openrouterKey.trim()}
          <div class="actions save"><button type="submit" class="primary small" data-testid="voice-save" disabled={busy}><span class="ui-label">{strings.speech.saveKeys}</span></button></div>
        {/if}
        <label class="switch-row">
          <span class="text">{strings.speech.fallback}<InfoTip topic={strings.speech.fallback} text={strings.speech.fallbackHint} /></span>
          <input type="checkbox" role="switch" data-testid="voice-fallback" checked={config.fallback} disabled={busy} onchange={(event) => void apply({ fallback: event.currentTarget.checked })} />
        </label>
      </form>
    {/if}
  {/if}
</div>

<style>
  header h1 { display: flex; align-items: center; gap: 6px; }
  .saved { display: inline-flex; gap: 6px; align-items: center; font-size: var(--text-sm); white-space: nowrap; color: var(--color-success); }

  /* The one line that answers "can I dictate now", with the single action that gets there. */
  .status-line { display: flex; align-items: center; gap: 12px; }
  .status-line .text { flex: 1; min-width: 0; font-weight: 500; }
  .status-line .hint, .model .hint, .key .hint { display: block; margin-top: 2px; color: var(--color-muted-foreground); font-size: var(--text-sm); font-weight: 400; }
  .status-line > button { flex: none; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--color-subtle); }
  .dot.ok { background: var(--color-success); }
  .dot.busy { background: var(--color-accent); }
  .status-line :global(.alert) { flex: none; color: var(--color-danger); }
  .reason { overflow-wrap: anywhere; }
  .hint.ok { color: var(--color-success); }
  .bytes { font-variant-numeric: tabular-nums; }
  progress { display: block; width: 100%; height: 4px; margin-top: 12px; accent-color: var(--color-accent); }
  .error { max-width: var(--settings-width); margin: 0 0 16px; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }

  .language { width: 88px; text-align: center; }

  /* A model is a radio with its size; the action on its right downloads or removes it. */
  .model { gap: 12px; }
  .pick { flex: 1; min-width: 0; height: auto; display: flex; align-items: center; gap: 12px; padding: 0; text-align: left; white-space: normal; font: inherit; color: inherit; background: none; border: none; box-shadow: none; }
  .pick:disabled { opacity: 1; }
  .pick .text { font-weight: 500; }
  .radio { flex: none; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--color-edge); transition: border-color var(--dur-2) var(--ease-out-quint), border-width var(--dur-2) var(--ease-out-quint); }
  .pick:hover:not(:disabled) .radio { border-color: var(--color-muted-foreground); }
  .pick[aria-checked='true'] .radio { border: 5px solid var(--color-accent); }
  .model :global(.spinner) { flex: none; margin: 0 8px; color: var(--color-muted-foreground); animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .field { display: flex; align-items: center; gap: 8px; flex: 0 1 380px; min-width: 0; }
  .field input { flex: 1; min-width: 0; }
  .field button { flex: none; }
  .save { justify-content: flex-end; padding-bottom: 12px; }
  .paths { display: grid; gap: 12px; padding-top: 12px; }
  .paths label { display: grid; gap: 6px; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  details { margin-top: 8px; }

  /* The options in one track, the chosen one filled like a primary button, as on Appearance. */
  .segmented { display: inline-flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--color-edge); border-radius: var(--radius-md); background: var(--color-surface-2); }
  .segmented button { height: var(--control-sm); padding: 0 12px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted-foreground); font-size: var(--text-sm); box-shadow: none; }
  .segmented button:hover:not(.on):not(:disabled) { background: var(--color-surface-3); color: var(--color-foreground); }
  .segmented button.on { background: var(--color-foreground); border-color: var(--color-foreground); color: var(--color-on-foreground); }
  .segmented button:disabled { opacity: 1; }

  @media (max-width: 720px) {
    :global(.settings .page) .switch-row:has(.segmented),
    :global(.settings .page) .switch-row.link,
    :global(.settings .page) .switch-row.key { flex-direction: column; align-items: stretch; gap: 10px; }
    .segmented button { flex: 1; min-width: 0; }
    .field { flex-basis: auto; }
    .field input, .field button { min-height: var(--touch-target); }
    .status-line { flex-wrap: wrap; }
    .status-line > button { flex-basis: 100%; min-height: var(--touch-target); }
  }
  @media (prefers-reduced-motion: reduce) { .model :global(.spinner) { animation: none; } }
</style>
