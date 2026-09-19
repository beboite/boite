<script lang="ts">
  import { Check, Cloud, Cpu, Download, Trash2 } from '@lucide/svelte';
  import type { SpeechConfig, SpeechStatus } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  let { store, readOnly = false }: { store: Store; readOnly?: boolean } = $props();
  let config = $state<SpeechConfig | null>(null);
  let status = $state<SpeechStatus | null>(null);
  let groqKey = $state(''), openrouterKey = $state('');
  let clearGroq = $state(false), clearOpenrouter = $state(false);
  let busy = $state(false), saved = $state(false), error = $state('');
  $effect(() => {
    const client = store.client;
    if (!client || store.connection !== 'ready') return;
    let live = true;
    const refresh = async () => { try { const next = await client.call('speech.status', {}); if (live) status = next; } catch (cause) { if (live) error = String(cause instanceof Error ? cause.message : cause); } };
    void refresh();
    if (store.owner && !readOnly) void client.call('speech.config', {}).then(value => { if (live) config = value; }).catch(cause => { if (live) error = cause.message; });
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 1000);
    return () => { live = false; clearInterval(timer); };
  });
  async function save() {
    if (!config || !store.client) return;
    busy = true; saved = false; error = '';
    try {
      status = await store.client.call('speech.configure', {
        ...config,
        ...(clearGroq || groqKey ? { groqKey: clearGroq ? '' : groqKey.trim() } : {}),
        ...(clearOpenrouter || openrouterKey ? { openrouterKey: clearOpenrouter ? '' : openrouterKey.trim() } : {}),
      });
      groqKey = ''; openrouterKey = ''; clearGroq = false; clearOpenrouter = false; saved = true;
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  async function manage(method: 'speech.install' | 'speech.installCancel' | 'speech.uninstall') {
    if (!store.client) return;
    busy = true; error = '';
    try { status = await store.client.call(method, {}); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
</script>

<div class="page" data-testid="voice-settings">
  <header><div><h1>{strings.speech.heading}</h1><p>{strings.speech.description}</p></div></header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if status?.error}<p class="error" role="alert">{status.error}</p>{/if}
  {#if !store.owner || readOnly}<section class="card"><p>{strings.speech.ownerOnly}</p><p class="hint">{status?.ready ? strings.speech.ready : strings.speech.setup}</p></section>
  {:else if config && status}
    <form onsubmit={(event) => { event.preventDefault(); void save(); }} oninput={() => saved = false}>
      <div class="engines" aria-label={strings.speech.heading}>
        <button type="button" class:chosen={config.engine === 'local'} aria-pressed={config.engine === 'local'} data-testid="voice-local" onclick={() => { config!.engine = 'local'; saved = false; }}><Cpu size={20} /><span>{strings.speech.local}</span><small>{strings.speech.localHint}</small></button>
        <button type="button" class:chosen={config.engine === 'api'} aria-pressed={config.engine === 'api'} data-testid="voice-api" onclick={() => { config!.engine = 'api'; saved = false; }}><Cloud size={20} /><span>{strings.speech.api}</span><small>{strings.speech.apiHint}</small></button>
      </div>
      {#if config.engine === 'local'}
        <section class="card">
          <div class="title"><h2>{strings.speech.model}</h2><span class:ready={status.localReady} class="badge">{status.localReady ? strings.speech.ready : strings.speech.missing}</span></div>
          <p class="hint">{strings.speech.modelHint}</p>
          {#if status.installing}
            <div class="download" role="status"><span>{strings.speech.downloading}</span><span>{Math.round(status.downloadedBytes / 1_000_000)} / {Math.round(status.totalBytes / 1_000_000)} MB</span></div>
            <progress value={status.downloadedBytes} max={status.totalBytes || 1}></progress>
            <div class="actions"><button type="button" disabled={busy} onclick={() => void manage('speech.installCancel')}>{strings.common.cancel}</button></div>
          {:else}
            <div class="actions"><button type="button" data-testid="voice-install" disabled={busy} onclick={() => void manage('speech.install')}><Download size={15} />{status.canInstallRuntime ? strings.speech.installWindows : strings.speech.install}</button>
            {#if status.localReady}<button type="button" class="ghost" data-testid="voice-uninstall" disabled={busy} onclick={() => void manage('speech.uninstall')}><Trash2 size={15} />{strings.speech.remove}</button>{/if}</div>
          {/if}
          {#if !status.canInstallRuntime}<p class="hint">{strings.speech.runtimeHint}</p>{/if}
          <details class="disclosure"><summary>{strings.speech.advanced}</summary><p class="hint">{strings.speech.pathHint}</p>
            <label><span>{strings.speech.executable}</span><input data-testid="voice-executable" bind:value={config.executable} spellcheck="false" /></label>
            <label><span>{strings.speech.modelPath}</span><input data-testid="voice-model-path" bind:value={config.modelPath} spellcheck="false" /></label>
          </details>
        </section>
      {:else}
        <section class="card">
          <h2>{strings.speech.provider}</h2>
          <div class="segmented"><button type="button" aria-pressed={config.apiProvider === 'groq'} onclick={() => { config!.apiProvider = 'groq'; saved = false; }}>{strings.speech.groq}</button><button type="button" aria-pressed={config.apiProvider === 'openrouter'} onclick={() => { config!.apiProvider = 'openrouter'; saved = false; }}>{strings.speech.openrouter}</button></div>
          <p class="hint">{strings.speech.groqModel}</p>
          <label><span>{strings.speech.groqKey}</span><input type="password" autocomplete="new-password" data-testid="voice-groq-key" bind:value={groqKey} disabled={clearGroq} placeholder={status.groqKeySet ? strings.speech.keySaved : strings.speech.keyEmpty} /></label>
          {#if status.groqKeySet}<label class="check"><input type="checkbox" bind:checked={clearGroq} />{strings.speech.clearKey}</label>{/if}
          <label><span>{strings.speech.openrouterKey}</span><input type="password" autocomplete="new-password" data-testid="voice-openrouter-key" bind:value={openrouterKey} disabled={clearOpenrouter} placeholder={status.openrouterKeySet ? strings.speech.keySaved : strings.speech.keyEmpty} /></label>
          {#if status.openrouterKeySet}<label class="check"><input type="checkbox" bind:checked={clearOpenrouter} />{strings.speech.clearKey}</label>{/if}
          <label class="check"><input type="checkbox" bind:checked={config.fallback} />{strings.speech.fallback}</label><p class="hint">{strings.speech.fallbackHint}</p>
        </section>
      {/if}
      <section class="card"><label><span>{strings.speech.language}</span><input class="language" maxlength="2" pattern="[a-z]{2}|" bind:value={config.language} placeholder="auto" aria-describedby="voice-language-hint" /></label><p class="hint" id="voice-language-hint">{strings.speech.languageHint}</p></section>
      <div class="actions"><button type="submit" class="primary" data-testid="voice-save" disabled={busy}>{strings.speech.save}</button>{#if saved}<span class="saved" role="status"><Check size={15} />{strings.speech.saved}</span>{/if}</div>
    </form>
  {/if}
  <footer><p class="hint">{strings.speech.privacy}</p><p class="hint">{strings.speech.limit}</p></footer>
</div>

<style>
  /* The engine choice reads as two large options above the cards of the one chosen. */
  .engines { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-width: 880px; margin-bottom: 20px; }
  .engines button { height: auto; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; padding: 18px; gap: 8px; text-align: left; white-space: normal; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); color: var(--color-foreground); }
  .engines button :global(svg) { color: var(--color-muted-foreground); }
  .engines button.chosen { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .engines button.chosen :global(svg) { color: var(--color-accent); }
  .engines span { font-size: var(--text-base); font-weight: 500; }
  .engines small { color: var(--color-muted-foreground); font-size: var(--text-sm); font-weight: 400; line-height: 1.5; }
  /* Inside a card each field, hint and row stands 12 px from the one above. */
  .card { display: flex; flex-direction: column; gap: 12px; }
  .card .title { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .card .title h2, .card > h2:first-child { margin: 0; }
  .badge { font-size: var(--text-sm); color: var(--color-muted-foreground); } .ready, .saved { color: var(--color-success); }
  .saved { display: inline-flex; gap: 6px; align-items: center; font-size: var(--text-sm); }
  .download { display: flex; justify-content: space-between; gap: 10px; font-size: var(--text-sm); }
  label { display: flex; flex-direction: column; gap: 6px; }
  label > span { margin: 0; }
  input { width: 100%; } .language { max-width: 120px; }
  .check { flex-direction: row; align-items: center; gap: 8px; font-size: var(--text-sm); } .check input { width: 16px; flex: none; }
  details { padding-top: 12px; border-top: 1px solid var(--color-border); }
  details > :global(* + *) { margin-top: 12px; }
  .segmented { display: flex; gap: 4px; } .segmented button[aria-pressed='true'] { background: var(--color-active); }
  progress { width: 100%; accent-color: var(--color-accent); height: 6px; }
  .error { max-width: 880px; margin-bottom: 16px; color: var(--color-danger); overflow-wrap: anywhere; }
  footer { max-width: 880px; margin-top: 24px; }
  footer p + p { margin-top: 8px; }
  @media (max-width: 720px) { .engines { grid-template-columns: 1fr; } .engines button { padding: 14px; gap: 6px; } .actions button { min-height: var(--touch-target); } }
</style>
