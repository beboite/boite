<script lang="ts">
  import { Cloud, Cpu, Download, Check, Mic, Trash2 } from '@lucide/svelte';
  import type { SpeechConfig, SpeechStatus } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  let { store }: { store: Store } = $props();
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
    if (store.owner) void client.call('speech.config', {}).then(value => { if (live) config = value; }).catch(cause => { if (live) error = cause.message; });
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
  <header><Mic size={20} strokeWidth={1.75} /><div><h2>{strings.speech.heading}</h2><p>{strings.speech.description}</p></div></header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !store.owner}<div class="card"><p>{strings.speech.ownerOnly}</p><p class="subtle">{status?.ready ? strings.speech.ready : strings.speech.setup}</p></div>
  {:else if config && status}
    <form onsubmit={(event) => { event.preventDefault(); void save(); }} oninput={() => saved = false}>
      <div class="engines" aria-label={strings.speech.heading}>
        <button type="button" class:chosen={config.engine === 'local'} aria-pressed={config.engine === 'local'} data-testid="voice-local" onclick={() => { config!.engine = 'local'; saved = false; }}><Cpu size={20} /><span>{strings.speech.local}</span><small>{strings.speech.localHint}</small></button>
        <button type="button" class:chosen={config.engine === 'api'} aria-pressed={config.engine === 'api'} data-testid="voice-api" onclick={() => { config!.engine = 'api'; saved = false; }}><Cloud size={20} /><span>{strings.speech.api}</span><small>{strings.speech.apiHint}</small></button>
      </div>
      {#if config.engine === 'local'}
        <div class="card">
          <div class="row"><h3>{strings.speech.model}</h3><span class:ready={status.localReady} class="badge">{status.localReady ? strings.speech.ready : strings.speech.missing}</span></div>
          <p>{strings.speech.modelHint}</p>
          {#if status.installing}
            <div class="download" role="status"><span>{strings.speech.downloading}</span><span>{Math.round(status.downloadedBytes / 1_000_000)} / {Math.round(status.totalBytes / 1_000_000)} MB</span></div>
            <progress value={status.downloadedBytes} max={status.totalBytes || 1}></progress>
            <button type="button" disabled={busy} onclick={() => void manage('speech.installCancel')}>{strings.common.cancel}</button>
          {:else}
            <div class="actions"><button type="button" data-testid="voice-install" disabled={busy} onclick={() => void manage('speech.install')}><Download size={15} />{status.canInstallRuntime ? strings.speech.installWindows : strings.speech.install}</button>
            {#if status.localReady}<button type="button" class="ghost" data-testid="voice-uninstall" disabled={busy} onclick={() => void manage('speech.uninstall')}><Trash2 size={15} />{strings.speech.remove}</button>{/if}</div>
          {/if}
          {#if status.error}<p class="error" role="alert">{status.error}</p>{/if}
          {#if !status.canInstallRuntime}<p>{strings.speech.runtimeHint}</p>{/if}
          <details><summary>{strings.speech.advanced}</summary><p>{strings.speech.pathHint}</p>
            <label>{strings.speech.executable}<input data-testid="voice-executable" bind:value={config.executable} spellcheck="false" /></label>
            <label>{strings.speech.modelPath}<input data-testid="voice-model-path" bind:value={config.modelPath} spellcheck="false" /></label>
          </details>
        </div>
      {:else}
        <div class="card">
          <h3>{strings.speech.provider}</h3>
          <div class="segmented"><button type="button" aria-pressed={config.apiProvider === 'groq'} onclick={() => { config!.apiProvider = 'groq'; saved = false; }}>{strings.speech.groq}</button><button type="button" aria-pressed={config.apiProvider === 'openrouter'} onclick={() => { config!.apiProvider = 'openrouter'; saved = false; }}>{strings.speech.openrouter}</button></div>
          <p>{strings.speech.groqModel}</p>
          <label>{strings.speech.groqKey}<input type="password" autocomplete="new-password" data-testid="voice-groq-key" bind:value={groqKey} disabled={clearGroq} placeholder={status.groqKeySet ? strings.speech.keySaved : strings.speech.keyEmpty} /></label>
          {#if status.groqKeySet}<label class="check"><input type="checkbox" bind:checked={clearGroq} />{strings.speech.clearKey}</label>{/if}
          <label>{strings.speech.openrouterKey}<input type="password" autocomplete="new-password" data-testid="voice-openrouter-key" bind:value={openrouterKey} disabled={clearOpenrouter} placeholder={status.openrouterKeySet ? strings.speech.keySaved : strings.speech.keyEmpty} /></label>
          {#if status.openrouterKeySet}<label class="check"><input type="checkbox" bind:checked={clearOpenrouter} />{strings.speech.clearKey}</label>{/if}
          <label class="check"><input type="checkbox" bind:checked={config.fallback} />{strings.speech.fallback}</label><p>{strings.speech.fallbackHint}</p>
        </div>
      {/if}
      <div class="card"><label>{strings.speech.language}<input class="language" maxlength="2" pattern="[a-z]{2}|" bind:value={config.language} placeholder="auto" aria-describedby="voice-language-hint" /></label><p id="voice-language-hint">{strings.speech.languageHint}</p></div>
      <div class="actions"><button type="submit" class="primary" data-testid="voice-save" disabled={busy}>{strings.speech.save}</button>{#if saved}<span class="saved" role="status"><Check size={15} />{strings.speech.saved}</span>{/if}</div>
    </form>
  {/if}
  <footer><p>{strings.speech.privacy}</p><p>{strings.speech.limit}</p></footer>
</div>

<style>
  .page { max-width: 800px; margin: 0 auto; padding: 28px; display: flex; flex-direction: column; gap: 22px; }
  header { display: flex; gap: 12px; align-items: flex-start; }
  header :global(svg) { margin-top: 3px; color: var(--color-muted-foreground); }
  h2 { font-size: var(--text-lg); } h3 { font-size: var(--text-base); font-weight: 500; }
  p, small { color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.6; }
  form { display: flex; flex-direction: column; gap: 16px; }
  .engines { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .engines button { height: auto; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; padding: 18px; gap: 10px; text-align: left; white-space: normal; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); }
  .engines button.chosen { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .engines span { font-size: var(--text-base); font-weight: 500; }
  .card { padding: 20px; display: flex; flex-direction: column; gap: 12px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); }
  .row, .actions, .download { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .row, .download { justify-content: space-between; }
  .badge { font-size: var(--text-sm); color: var(--color-muted-foreground); } .ready, .saved { color: var(--color-success); }
  .saved { display: inline-flex; gap: 6px; align-items: center; font-size: var(--text-sm); }
  label { display: flex; flex-direction: column; gap: 7px; font-size: var(--text-sm); }
  input { width: 100%; } .language { max-width: 120px; } .check { flex-direction: row; align-items: center; } .check input { width: 16px; flex: none; }
  details { border-top: 1px solid var(--color-border); padding-top: 12px; } summary { cursor: pointer; font-size: var(--text-sm); } details label, details p { margin-top: 12px; }
  .segmented { display: flex; gap: 4px; } .segmented button[aria-pressed='true'] { background: var(--color-active); }
  progress { width: 100%; accent-color: var(--color-accent); height: 6px; } .download { font-size: var(--text-sm); }
  .error { color: var(--color-danger); overflow-wrap: anywhere; } footer p + p { margin-top: 8px; }
  @media (max-width: 720px) { .page { padding: 20px 16px; } .engines { grid-template-columns: 1fr; } .engines button { padding: 14px; gap: 6px; } .card { padding: 16px; } .actions button { min-height: var(--touch-target); } }
</style>
