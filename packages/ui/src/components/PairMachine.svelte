<script lang="ts">
  import { ClipboardPaste, Plus, ScanLine, X } from '@lucide/svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { parsePairingLink } from '../lib/endpoint';
  import { fill, strings } from '../lib/strings';
  import InfoTip from './InfoTip.svelte';
  import { appPage, reachableFromApp } from '../lib/app-origin';
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
    // The camera's code did not load: a pasted link is the other way in, opened in its place.
    catch { workspace.error = strings.phone.dialogOffline; if (mobile) pasting = true; else adding = true; }
  }
  /** A code that reads as a link to add a device connects at once; the machine names itself and the card renames it. */
  async function scanned(text: string) {
    scanning = false;
    link = text;
    if (!mobile) adding = true;
    await add();
  }

  // The phone app's page is no machine's: a link naming plain http is turned down before its socket fails.
  const app = appPage();
  /**
   * A phone whose camera cannot read the code pastes the link instead, sent
   * from the machine that drew it. The link names that machine, so it works
   * from the app's own page as from a page a machine serves.
   */
  let pasting = $state(false);
  function togglePaste() {
    workspace.error = null;
    pasting = !pasting;
    if (pasting) requestAnimationFrame(() => linkInput?.focus());
  }

  let target = $derived(workspace.linkTarget(link));
  export function startAdding() {
    workspace.error = null;
    // A phone adds itself with its camera: the code, not a link to paste.
    if (mobile) { void startScanning(); return; }
    adding = true;
    requestAnimationFrame(() => linkInput?.focus());
  }
  function stopAdding() {
    workspace.error = null;
    adding = false;
    pasting = false;
    link = '';
    token = '';
    url = '';
  }
  async function add(manual = false) {
    if (busy) return;
    // The app's page is HTTPS: a scanned code naming a plain http machine would only fail as a socket error.
    const target = manual ? url.trim() : parsePairingLink(link)?.url;
    if (app && target !== undefined && !reachableFromApp(target)) {
      workspace.error = strings.machines.linkInsecure;
      return;
    }
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
        {#if mobile}<button class="add-open" data-testid="machine-paste-open" aria-expanded={pasting} onclick={togglePaste}><ClipboardPaste size={15} /><span class="ui-label">{strings.machines.pasteLink}</span></button>{/if}
        {#if !open && !mobile}<button class="primary add-open" data-testid="machine-add-open" onclick={startAdding}><Plus size={15} /><span class="ui-label">{strings.machines.add}</span></button>{/if}
      </div>
    {/if}
  {#if mobile && !pasting && workspace.error}<p class="error" role="alert">{workspace.error}</p>{/if}
  {#if mobile && pasting}
    <form class="card paste-form" data-testid="machine-paste-form" onsubmit={(e) => { e.preventDefault(); void add(); }}>
      <!-- Another link pasted: the last one's refusal no longer applies. -->
      <label>{strings.machines.link}<input
          bind:this={linkInput}
          bind:value={link}
          oninput={() => { workspace.error = null; }}
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
      <p class="paste-hint">{strings.machines.addHint}</p>
      <button type="submit" class="primary" data-testid="machine-add" disabled={busy || !link.trim()}>{busy ? strings.machines.adding : strings.machines.connect}</button>
      {#if workspace.error}<p class="error" role="alert">{workspace.error}</p>{/if}
    </form>
  {/if}
  <!-- A computer's browser pastes the link, with a URL and a token beside it; a phone scans, or pastes when its camera cannot. -->
  {#if !mobile}
  <div class="disclosure-fold" class:open inert={!open}>
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

  {/if}

  {#if scanning && QrScanner}
    <QrScanner accept={(text) => parsePairingLink(text) !== null} onresult={(text) => void scanned(text)} onclose={() => (scanning = false)} />
  {/if}
</div>

<style>
  .pair-machine { margin-bottom: 20px; }
  .head-actions { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 12px; }
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
  .paste-form { padding: 16px; margin: 0 0 12px; }
  .paste-hint { margin: 0; font-size: var(--text-xs); color: var(--color-muted-foreground); }
</style>
