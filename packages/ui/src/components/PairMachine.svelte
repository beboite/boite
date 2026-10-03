<script lang="ts">
  import { KeyRound, Plus, ScanLine, X } from '@lucide/svelte';
  import { normalizePairingCode } from '@boite/contracts';
  import { workspace } from '../lib/workspace.svelte';
  import { parsePairingLink } from '../lib/endpoint';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';
  let { mobile = false, onpaired }: { mobile?: boolean; onpaired?: () => void } = $props();
  let link = $state(''),
    url = $state(''),
    token = $state('');
  let busy = $state(false);
  /** The add form stays folded behind its button, unless there is nothing else to show. */
  let adding = $state(false);
  let open = $derived(adding || (!mobile && workspace.machines.length === 0));
  let linkInput = $state<HTMLInputElement | null>(null);
  /** The camera view, loaded on the first scan: a phone that never scans never downloads it. */
  let QrScanner = $state<typeof import('./QrScanner.svelte').default>();
  let scanning = $state(false);
  async function startScanning() {
    workspace.error = null;
    try { QrScanner ??= (await import('./QrScanner.svelte')).default; scanning = true; }
    catch { workspace.error = strings.phone.dialogOffline; adding = true; }
  }
  /** A code that reads as a pairing link connects at once; the machine names itself and the card renames it. */
  async function scanned(text: string) {
    scanning = false;
    link = text;
    adding = true;
    await add();
  }

  /**
   * A code typed in the installed app pairs it with the core that serves this
   * page. The camera app would hand a link to Safari, whose storage the
   * home-screen app does not share; a code typed here stays here.
   */
  const codeOrigin = window.__TAURI_INTERNALS__ === undefined && /^https?:$/.test(location.protocol) ? location.origin : null;
  let codeOpen = $state(false);
  let code = $state('');
  let codeError = $state('');
  let codeInput = $state<HTMLInputElement | null>(null);
  function toggleCode() {
    workspace.error = null;
    codeError = '';
    codeOpen = !codeOpen;
    if (codeOpen) requestAnimationFrame(() => codeInput?.focus());
  }
  async function pairCode() {
    if (busy || !codeOrigin) return;
    const canonical = normalizePairingCode(code);
    if (!canonical) {
      codeError = strings.machines.codeInvalid;
      return;
    }
    codeError = '';
    busy = true;
    try {
      if (await workspace.pair(`${codeOrigin}/?grant=${canonical}`, '')) {
        code = '';
        codeOpen = false;
        onpaired?.();
      }
    } finally {
      busy = false;
    }
  }

  let target = $derived(workspace.linkTarget(link));
  export function startAdding() {
    workspace.error = null;
    adding = true;
    requestAnimationFrame(() => linkInput?.focus());
  }
  function stopAdding() {
    workspace.error = null;
    adding = false;
    link = '';
    token = '';
    url = '';
  }
  async function add(manual = false) {
    if (busy) return;
    busy = true;
    try {
      const ok = manual
        ? await workspace.add({ url: url.trim(), token })
        : await workspace.pair(link.trim(), '');
      if (ok) { stopAdding(); onpaired?.(); }
    } finally {
      busy = false;
    }
  }

</script>

<div class="pair-machine" class:mobile>
    {#if mobile || !open}
      <div class="head-actions">
        <!-- A phone has a camera and the other machine draws a code: no link to copy across. -->
        {#if mobile}<button class="primary add-open" data-testid="machine-scan" disabled={busy} onclick={() => void startScanning()}><ScanLine size={15} /><span class="ui-label">{strings.machines.scan}</span></button>{/if}
        {#if mobile && codeOrigin}<button class="add-open" data-testid="machine-code-open" aria-expanded={codeOpen} onclick={toggleCode}><KeyRound size={15} /><span class="ui-label">{strings.machines.typeCode}</span></button>{/if}
        {#if !open}<button class:primary={!mobile} class="add-open" data-testid="machine-add-open" onclick={startAdding}><Plus size={15} /><span class="ui-label">{mobile ? strings.machines.pasteLink : strings.machines.add}</span></button>{/if}
      </div>
    {/if}
  {#if codeOpen && codeOrigin}
    <form class="card code-form" data-testid="machine-code-form" onsubmit={(e) => { e.preventDefault(); void pairCode(); }}>
      <label>{strings.machines.codeLabel}<input
          bind:this={codeInput}
          bind:value={code}
          data-testid="machine-code"
          type="text"
          inputmode="text"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          maxlength="16"
          placeholder={strings.machines.codePlaceholder}
        /></label>
      <p class="code-hint">{strings.machines.codeHint}</p>
      <button type="submit" class="primary" data-testid="machine-code-submit" disabled={busy || !code.trim()}>{busy ? strings.machines.adding : strings.machines.connect}</button>
      {#if codeError || workspace.error}<p class="error" role="alert">{codeError || workspace.error}</p>{/if}
    </form>
  {/if}
  <div class="reveal" class:open inert={!open}>
    <div>
      <section class="card add" data-testid="machine-add-card" aria-label={strings.machines.add}>
        <div class="add-head">
          <h2 class="ui-label-box"><span class="ui-label">{strings.machines.add}</span><InfoTip topic={strings.machines.add} text={strings.machines.addHint} /></h2>
          {#if workspace.machines.length > 0}
            <button class="ghost icon-only" data-testid="machine-add-close" aria-label={strings.common.cancel} title={strings.common.cancel} onclick={stopAdding}><X size={15} /></button>
          {/if}
        </div>
        <form
          onsubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label>{strings.machines.link}<input
              bind:this={linkInput}
              bind:value={link}
              data-testid="machine-link"
              type="password"
              autocomplete="off"
              spellcheck="false"
            /></label>
          {#if target}
            <p class="link-target" data-testid="machine-link-target">{target.machine
              ? fill(target.machine.store.connection === 'ready' ? strings.machines.linkConnected : strings.machines.linkReplaces, { host: target.host, machine: target.machine.label })
              : fill(strings.machines.linkReaches, { host: target.host })}</p>
          {/if}
          <button type="submit" class="primary" data-testid="machine-add" disabled={busy || !link.trim()}
            ><Plus size={14} /><span class="ui-label">{busy ? strings.machines.adding : strings.machines.connect}</span></button
          >
        </form>
        <details class="disclosure">
          <summary><span class="ui-label">{strings.machines.manual}</span></summary>
          <form
            onsubmit={(e) => {
              e.preventDefault();
              void add(true);
            }}
          >
            <label>{strings.settings.coreUrl}<input bind:value={url} data-testid="machine-url" autocomplete="off" spellcheck="false" /></label>
            <label>{strings.settings.token}<input bind:value={token} data-testid="machine-token" type="password" autocomplete="off" /></label>
            <button class="primary" disabled={busy || !url.trim() || !token}
              ><span class="ui-label">{busy ? strings.machines.adding : strings.machines.connect}</span></button
            >
          </form>
        </details>
        {#if workspace.error}<p class="error" role="alert">{workspace.error}</p>{/if}
      </section>
    </div>
  </div>

  {#if scanning && QrScanner}
    <QrScanner accept={(text) => parsePairingLink(text) !== null} onresult={(text) => void scanned(text)} onclose={() => (scanning = false)} />
  {/if}
</div>

<style>
  .pair-machine { margin-bottom: 20px; }
  .head-actions { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 12px; }
  .reveal { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--dur-3) var(--ease-out-quint), opacity var(--dur-2); }
  .reveal.open { grid-template-rows: 1fr; opacity: 1; }
  .reveal > div { overflow: hidden; min-height: 0; }
  .add { padding: 20px; display: flex; flex-direction: column; gap: 10px; }
  .add-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  h2 { font-size: var(--text-base); margin: 0; }
  form { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; margin-top: 6px; }
  label { display: flex; flex-direction: column; gap: 6px; width: 100%; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  input { width: 100%; min-width: 0; }
  details { margin-top: 8px; color: var(--color-muted-foreground); font-size: var(--text-sm); }
  summary { cursor: pointer; }
  .link-target, .error { font-size: var(--text-sm); overflow-wrap: anywhere; margin: 0; }
  .link-target { color: var(--color-muted-foreground); }
  .error { color: var(--color-danger); }
  .mobile .head-actions { flex-direction: column; }
  .mobile .add-open { width: 100%; min-height: var(--touch-target); }
  .mobile .add { padding: 16px; }
  .mobile form > button { width: 100%; }
  .code-form { padding: 16px; margin: 0 0 12px; }
  .code-form input { font-family: var(--font-mono); font-size: var(--text-base); letter-spacing: 1.5px; text-transform: uppercase; }
  .code-hint { margin: 0; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  @media (prefers-reduced-motion: reduce) { .reveal { transition: none; } }
</style>
