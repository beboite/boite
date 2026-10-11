<script lang="ts">
  import { Check, Copy, X } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import FirewallNotice from './FirewallNotice.svelte';
  import LanReach, { isLoopback } from './LanReach.svelte';
  import { time } from '../lib/format';
  import { qrSvg } from '../lib/qr';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * "Add a device": one QR code and one short code under it. A phone scans
   * the code or types the letters; a computer copies the link and pastes it
   * under Join. A link that names loopback reaches nothing but this computer,
   * so it gets no QR code and offers the local network instead.
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();
  const invite = $derived(store.deviceInvite);
  const loopback = $derived(!!invite && isLoopback(invite.url));

  let qr = $state('');
  $effect(() => {
    // The phone's part only: the invitation a computer joins with stays in the copied link, and out of a denser code.
    const url = invite?.url.split('#')[0];
    if (!url) {
      qr = '';
      return;
    }
    let live = true;
    void qrSvg(url).then((svg) => { if (live) qr = svg; });
    return () => { live = false; };
  });

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(timer));
  let linkInput = $state<HTMLInputElement>();
  /**
   * A page served over plain HTTP has no clipboard API: the link is selected
   * in its field and copied the older way, and stays selected to copy by hand.
   */
  async function copy() {
    try {
      await navigator.clipboard.writeText(invite?.url ?? '');
    } catch {
      linkInput?.focus();
      linkInput?.select();
      if (!document.execCommand?.('copy')) return;
    }
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => { copied = false; }, 1500);
  }
  let firewall: FirewallNotice | undefined = $state();
</script>

{#if invite}
  <div class="add-device" data-testid="add-device" data-link={invite.url}>
    {#if qr && !loopback}
      <div class="qr" data-testid="add-device-qr" role="img" aria-label={strings.group.qr}>{@html qr}</div>
    {/if}
    <div class="text">
      {#if !loopback}
        <p class="code-label">{strings.group.code}</p>
        <p class="code mono" data-testid="add-device-code">{invite.code}</p>
        <p class="hint">{strings.group.addHint}</p>
        <p class="hint">{fill(strings.group.expires, { time: time(invite.codeExpiresAt) })}</p>
      {/if}
      <label class="link-label" for="{uid}-link">{strings.group.link}</label>
      <input id="{uid}-link" class="mono link" data-testid="add-device-link" readonly spellcheck="false" autocomplete="off" bind:this={linkInput}
        value={invite.url} onfocus={(event) => event.currentTarget.select()} />
      <div class="buttons">
        <button type="button" data-testid="add-device-copy" onclick={() => void copy()}>
          {#if copied}<Check size={14} />{strings.group.copied}{:else}<Copy size={14} />{strings.group.copyLink}{/if}
        </button>
        <button type="button" class="ghost icon-only" data-testid="add-device-close" aria-label={strings.common.close} title={strings.common.close} onclick={() => store.closeDeviceInvite()}><X size={15} /></button>
      </div>
      <LanReach {store} {loopback} {firewall} />
    </div>
  </div>
  <FirewallNotice {store} bind:this={firewall} />
{/if}

<style>
  .add-device {
    display: flex;
    align-items: flex-start;
    gap: 18px;
    margin-top: 14px;
    padding: 16px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-lg);
    background: var(--color-surface-2);
    animation: rise var(--dur-3) var(--ease-out-quint);
  }
  .qr {
    flex: none;
    width: 168px;
    height: 168px;
    padding: 10px;
    box-sizing: border-box;
    border-radius: var(--radius-md);
    /* A QR code reads dark on light whatever the theme: a camera needs the contrast. */
    background: white;
  }
  .qr :global(svg) { display: block; width: 100%; height: 100%; }
  .text { flex: 1; min-width: 0; display: grid; gap: 6px; align-content: start; }
  .code-label { margin: 0; font-size: var(--text-xs); color: var(--color-muted-foreground); text-transform: uppercase; letter-spacing: 0.6px; }
  .code {
    margin: 0 0 6px;
    font-size: 28px;
    font-weight: 600;
    letter-spacing: 3px;
    color: var(--color-foreground);
    user-select: all;
  }
  .hint { margin: 0; }
  .buttons { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .link-label { margin-top: 8px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .link { width: 100%; min-width: 0; font-size: var(--text-xs); }
  .icon-only { width: var(--control); padding: 0; color: var(--color-muted-foreground); }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .add-device { animation: none; } }
  @media (max-width: 520px) {
    .add-device { flex-direction: column; align-items: center; text-align: center; }
    .buttons { justify-content: center; }
  }
</style>
