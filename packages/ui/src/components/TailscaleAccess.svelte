<script lang="ts">
  import { untrack } from 'svelte';
  import type { TailscaleStatus } from '@boite/contracts';
  import InfoTip from './InfoTip.svelte';
  import { confirm } from '../lib/confirm.svelte';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';

  /**
   * The owner's switch for serving this core over HTTPS through `tailscale
   * serve`. Each state the CLI can be in has its sentence and its way out;
   * 443 already serving something else is replaced only after a confirmation.
   */
  let { store }: { store: Store } = $props();
  const text = strings.phone.tailscale;

  let status = $state<TailscaleStatus | null>(null);
  let busy = $state(false);
  let failure = $state('');

  async function call(method: 'tailscale.status' | 'tailscale.disable'): Promise<void>;
  async function call(method: 'tailscale.enable', replace: boolean): Promise<void>;
  async function call(method: 'tailscale.status' | 'tailscale.enable' | 'tailscale.disable', replace = false): Promise<void> {
    const client = store.client;
    if (!client || busy) return;
    busy = true;
    failure = '';
    try {
      status = method === 'tailscale.enable' ? await client.call(method, { replace }) : await client.call(method, {});
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    } finally {
      busy = false;
    }
  }

  // Read on arrival and on each reconnection; the call's own state is not a reason to read again.
  $effect(() => {
    if (store.connection === 'ready' && store.owner) untrack(() => void call('tailscale.status'));
  });

  async function enable(replace = false) {
    if (replace && status) {
      const ok = await confirm.ask({
        title: fill(text.replaceTitle, { url: status.url ?? '' }),
        body: fill(text.replaceBody, { target: status.servedTarget ?? '' }),
        confirmLabel: text.replaceConfirm,
        cancelLabel: strings.common.cancel,
        danger: true
      });
      if (!ok) return;
    }
    await call('tailscale.enable', replace);
    if (status?.state === 'on') pair();
  }

  async function disable() {
    const ok = await confirm.ask({
      title: text.disableTitle,
      body: fill(text.disableBody, { url: status?.url ?? '' }),
      confirmLabel: text.disable,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) await call('tailscale.disable');
  }

  /** A phone's link through the new address, shown with its QR code in the pairing card above. */
  function pair() {
    void store.mintPairing('device');
    requestAnimationFrame(() => document.getElementById('settings-devices')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  }

  let sentence = $derived.by(() => {
    if (!status) return text.checking;
    switch (status.state) {
      case 'missing': return text.missing;
      case 'stopped': return text.stopped;
      case 'needs-login': return text.needsLogin;
      case 'https-disabled': return text.httpsDisabled;
      case 'off': return fill(text.off, { url: status.url ?? '' });
      case 'on': return fill(text.on, { url: status.url ?? '' });
      case 'conflict': return fill(text.conflict, { url: status.url ?? '', target: status.servedTarget ?? '' });
      case 'error': return text.error;
    }
  });
  let link = $derived.by((): { href: string; label: string } | null => {
    if (!status) return null;
    if (status.state === 'missing') return { href: 'https://tailscale.com/download', label: text.download };
    if (status.detail === 'serve-consent' && status.actionUrl) return { href: status.actionUrl, label: text.approve };
    if (status.state === 'needs-login' && status.actionUrl) return { href: status.actionUrl, label: text.signIn };
    if (status.state === 'https-disabled' && status.actionUrl) return { href: status.actionUrl, label: text.openAdmin };
    return null;
  });
</script>

<div class="tailscale" data-testid="tailscale-access" data-state={status?.state ?? 'checking'}>
  <span class="title">{text.heading}<InfoTip topic={text.heading} text={text.hint} /></span>
  <p class="hint" class:ok={status?.state === 'on'} data-testid="tailscale-state" role="status">{sentence}{#if status?.state === 'on' && status.publicUrlMatches}{' '}{text.onPublic}{/if}</p>
  {#if status?.detail}<p class="hint warn" data-testid="tailscale-detail">{text.details[status.detail]}</p>{/if}
  {#if failure}<p class="hint error" role="alert">{failure}</p>{/if}
  <div class="actions">
    {#if status?.state === 'off'}
      <button type="button" class="primary" data-testid="tailscale-enable" disabled={busy} onclick={() => void enable()}>{text.enable}</button>
    {:else if status?.state === 'conflict'}
      <button type="button" class="danger" data-testid="tailscale-replace" disabled={busy} onclick={() => void enable(true)}>{text.replace}</button>
    {:else if status?.state === 'on'}
      <button type="button" class="primary" data-testid="tailscale-pair" disabled={busy} onclick={pair}>{text.pair}</button>
      <button type="button" data-testid="tailscale-disable" disabled={busy} onclick={() => void disable()}>{text.disable}</button>
    {/if}
    {#if link}<a class="button" href={link.href} target="_blank" rel="noreferrer" data-testid="tailscale-link">{link.label}</a>{/if}
    <button type="button" class="quiet" data-testid="tailscale-refresh" disabled={busy || store.connection !== 'ready'} onclick={() => void call('tailscale.status')}>{text.refresh}</button>
  </div>
</div>

<style>
  .tailscale { display: flex; flex-direction: column; gap: 8px; }
  .title { display: inline-flex; align-items: center; font-weight: 600; font-size: var(--text-sm); }
  .hint { margin: 0; overflow-wrap: anywhere; }
  .ok { color: var(--color-foreground); }
  .warn { color: var(--color-live); }
  .error { color: var(--color-danger); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .danger { color: var(--color-danger); }
  a.button {
    display: inline-flex;
    align-items: center;
    height: var(--control);
    padding: 0 14px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-foreground);
    text-decoration: none;
  }
</style>
