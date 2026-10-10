<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import type { PairedSession, PairingLink, PairingNetwork } from '@boite/contracts';
  import { confirm } from '../lib/confirm.svelte';
  import { ago, exactTime, time } from '../lib/format';
  import { qrSvg } from '../lib/qr';
  import { fill, strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * Pairing a phone or another computer, and the devices already paired. The
   * local network switch sits here because it is the one thing a phone needs
   * before any link can reach it.
   */
  let { store }: { store: Store } = $props();
  const uid = $props.id();

  // Off mints a phone's link; on mints one for another computer of the owner's.
  let ownerLink = $state(false);

  // The devices list is read on arrival and after every `sessions.updated`;
  // the pairing link is minted on the button, never on its own.
  $effect(() => {
    if (store.connection === 'ready') void store.loadSessions();
  });

  // One grant, one link per address the core answers on: the home network for
  // a phone on the same Wi-Fi, a tailnet's for one away from home. The choice
  // of network outlives a new link, so a second phone gets the same kind.
  // The adapter is part of the choice: Wi-Fi and Ethernet are two LAN addresses.
  // The clicked address first, which a new grant changes; then its adapter, then its network.
  let chosen = $state<{ host: string; network: PairingNetwork; interface?: string } | null>(null);
  let links = $derived<PairingLink[]>(store.pairing ? (store.pairing.links ?? [{ url: store.pairing.url, network: 'lan' }]) : []);
  let shown = $derived(
    links.find((link) => hostOf(link.url) === chosen?.host)
      ?? links.find((link) => link.network === chosen?.network && link.interface === chosen.interface)
      ?? links.find((link) => link.network === chosen?.network)
      ?? links[0]
      ?? null
  );
  function linkLabel(link: PairingLink): string {
    const name = strings.settings.pairing.networks[link.network];
    const twins = links.filter((other) => other.network === link.network).length > 1;
    return twins && link.interface ? `${name} · ${link.interface}` : name;
  }
  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  // The QR code follows the chosen link: a new link redraws it, no link clears it.
  let qr = $state('');
  $effect(() => {
    const url = shown?.url;
    if (!url) {
      qr = '';
      return;
    }
    let live = true;
    void qrSvg(url).then((svg) => {
      if (live) qr = svg;
    });
    return () => {
      live = false;
    };
  });

  /** The app a device paired from, in plain words: `pwa` and `shell` are what the two clients call themselves. */
  function clientName(name: string): string {
    return name === 'pwa' ? strings.settings.pairing.clients.pwa : name === 'shell' ? strings.settings.pairing.clients.shell : name;
  }

  /** A switch saves when it flips, as every other switch in Settings does; a refusal puts it back. */
  async function toggleLan(input: HTMLInputElement) {
    const ok = await store.saveSettings({ listenOnLan: input.checked });
    if (!ok) input.checked = store.settings?.listenOnLan ?? !input.checked;
  }

  async function revoke(session: PairedSession) {
    const ok = await confirm.ask({
      title: strings.settings.pairing.revokeTitle,
      body: strings.settings.pairing.revokeBody,
      confirmLabel: strings.settings.pairing.revoke,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) await store.revokeSession(session.id);
  }

  /**
   * An owner link is pasted on a computer, never drawn: a QR code is a camera
   * away from any phone in the room. The owner's own phone may still get one,
   * after saying so here, and that one lives five minutes instead of ten.
   */
  async function ownerQr() {
    const ok = await confirm.ask({
      title: strings.settings.pairing.ownerQrTitle,
      body: strings.settings.pairing.ownerQrBody,
      confirmLabel: strings.settings.pairing.ownerQrConfirm,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (ok) await store.mintPairing('owner', true);
  }
</script>

<section class="card" id="settings-devices" data-testid="pairing-card">
  <h2 class="ui-label-box"><span class="ui-label">{strings.settings.pairing.heading}</span><InfoTip topic={strings.settings.pairing.heading} text={strings.settings.pairing.intro} /></h2>
  {#if store.principal === 'owner'}
    <div class="actions">
      <!-- The button says what its link is for: a phone, unless the switch under More options asks for another computer. -->
      <button type="button" class="primary" data-testid="pairing-mint" onclick={() => void store.mintPairing(ownerLink ? 'owner' : 'device')}>
        <span class="ui-label">{ownerLink ? strings.settings.pairing.mintOwner : strings.settings.pairing.mint}</span>
      </button>
      {#if store.pairing}
        <button type="button" data-testid="pairing-copy" onclick={() => void store.copy(shown?.url ?? store.pairing?.url ?? '')}><span class="ui-label">{strings.settings.pairing.copy}</span></button>
        {#if store.pairing.role === 'owner' && !store.pairing.code}
          <button type="button" data-testid="pairing-owner-qr" onclick={() => void ownerQr()}><span class="ui-label">{strings.settings.pairing.ownerQr}</span></button>
        {/if}
        <button type="button" class="quiet" data-testid="pairing-close" onclick={() => store.closePairing()}><span class="ui-label">{strings.common.close}</span></button>
      {/if}
    </div>
    {#if store.pairing && links.length > 1}
      <div class="networks" role="group" aria-label={strings.settings.pairing.network} data-testid="pairing-networks">
        {#each links as link (link.url)}
          <button type="button" class:on={link === shown} aria-pressed={link === shown} data-network={link.network} data-testid="pairing-network"
            title={hostOf(link.url)} onclick={() => (chosen = { host: hostOf(link.url), network: link.network, ...(link.interface === undefined ? {} : { interface: link.interface }) })}>
            {linkLabel(link)}
          </button>
        {/each}
      </div>
    {/if}
    {#if store.pairing}
      <div class="minted">
        <!-- A computer takes the link pasted, so its QR code would only be
             a camera away from the wrong device: an owner link is drawn only
             once confirmed for a phone, which gives it a code. -->
        {#if qr && (store.pairing.role !== 'owner' || store.pairing.code)}
          <div class="qr" data-testid="pairing-qr" aria-label={strings.settings.pairing.qr}>{@html qr}</div>
        {/if}
        <div class="minted-text">
          <p class="mono link" data-testid="pairing-link">{shown?.url ?? store.pairing.url}</p>
          <p class="hint">{store.pairing.role !== 'owner' ? strings.settings.pairing.scan : store.pairing.code ? strings.settings.pairing.ownerScan : strings.settings.pairing.pasteOwner}</p>
          {#if links.length > 1 && shown}
            <p class="hint" data-testid="pairing-network-hint">{strings.settings.pairing.networkHints[shown.network]}</p>
          {/if}
          <p class="hint">{fill(strings.settings.pairing.expires, { time: time(store.pairing.expiresAt) })}</p>
          {#if store.pairing.code}
            <div class="code-row">
              <span class="hint">{strings.settings.pairing.code}</span>
              <span class="mono code" data-testid="pairing-code">{store.pairing.code}</span>
            </div>
            {#if store.pairing.codeExpiresAt}<p class="hint">{fill(strings.settings.pairing.codeExpires, { time: time(store.pairing.codeExpiresAt) })}</p>{/if}
          {/if}
          {#if store.pairing.role !== 'owner' && store.settings && !store.settings.listenOnLan && !store.settings.publicUrl}
            <p class="hint warn" data-testid="pairing-lan-hint">{strings.settings.pairing.lanHint}</p>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <p class="hint">{strings.settings.pairing.paired}</p>
  {/if}
  <h3>{strings.settings.pairing.devices}</h3>
  {#if store.sessions.length === 0}
    <p class="hint">{strings.settings.pairing.noDevices}</p>
  {:else}
    <ul class="devices" data-testid="paired-devices">
      {#each store.sessions as session (session.id)}
        <li data-session-id={session.id}>
          <span class="name">
            {clientName(session.client.name)} <span class="subtle version">{session.client.version}</span>
            {#if session.role === 'owner'}<span class="subtle">({strings.settings.pairing.ownerTag})</span>{/if}
            {#if session.current}<span class="subtle">({strings.settings.pairing.thisDevice})</span>{/if}
          </span>
          <span class="subtle seen" title={exactTime(session.lastSeenAt)}>{fill(strings.settings.pairing.lastSeen, { when: ago(session.lastSeenAt) })}</span>
          {#if store.principal === 'owner'}
            <button type="button" class="ghost small danger" onclick={() => void revoke(session)}><span class="ui-label">{strings.settings.pairing.revoke}</span></button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if store.principal === 'owner'}
    <!-- What a phone on the same tailnet never needs: kept a click away, and open while one of them is on. -->
    <details class="disclosure options" data-testid="pairing-options" open={ownerLink || undefined}>
      <summary>{strings.settings.pairing.options}</summary>
      <label for="{uid}-listen-on-lan" class="switch-row">
        <span class="text ui-label-box">
          <span class="ui-label" id="{uid}-listen-on-lan-name">{strings.settings.listenOnLan}</span><InfoTip topic={strings.settings.listenOnLan} text={strings.settings.listenOnLanHint} />
        </span>
        <input id="{uid}-listen-on-lan" aria-labelledby="{uid}-listen-on-lan-name" type="checkbox" role="switch" data-testid="setting-listen-on-lan"
          checked={store.settings?.listenOnLan ?? false} disabled={!store.settings}
          onchange={(event) => void toggleLan(event.currentTarget)} />
      </label>
      <label for="{uid}-pairing-owner" class="switch-row">
        <span class="text ui-label-box">
          <span class="ui-label" id="{uid}-pairing-owner-name">{strings.settings.pairing.owner}</span><InfoTip topic={strings.settings.pairing.owner} text={strings.settings.pairing.ownerHint} />
        </span>
        <input id="{uid}-pairing-owner" aria-labelledby="{uid}-pairing-owner-name" type="checkbox" role="switch" data-testid="pairing-owner" bind:checked={ownerLink} />
      </label>
    </details>
  {/if}
</section>

<style>
  .actions { margin-top: 4px; }
  .options { margin-top: 16px; }
  .version { font-size: var(--text-xs); }
  /* The addresses in one track, the chosen one filled, as Appearance draws its choices. */
  .networks {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    width: fit-content;
    max-width: 100%;
    margin-top: 12px;
    padding: 2px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
  }
  .networks button {
    min-height: var(--control-sm);
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }
  .networks button:hover:not(.on) { background: var(--color-surface-3); color: var(--color-foreground); }
  .networks button.on { background: var(--color-foreground); border-color: var(--color-foreground); color: var(--color-on-foreground); }
  .minted { display: flex; align-items: flex-start; gap: 14px; margin-top: 14px; }
  .minted-text { flex: 1; min-width: 0; display: grid; gap: 6px; }
  .qr {
    flex: none;
    width: 132px;
    height: 132px;
    padding: 8px;
    box-sizing: border-box;
    border-radius: var(--radius-md);
    /* A QR code reads dark on light whatever the theme: a camera needs the contrast. */
    background: white;
    border: 1px solid var(--color-border);
  }
  .qr :global(svg) { display: block; width: 100%; height: 100%; }
  .link {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    font-size: var(--text-sm);
    word-break: break-all;
    user-select: all;
  }
  .hint { margin: 0; }
  .code-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .code {
    padding: 4px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: 1.5px;
    user-select: all;
  }
  .warn { color: var(--color-live); }
  h3 { font-size: var(--text-sm); font-weight: 600; color: var(--color-muted-foreground); margin: 20px 0 8px; }
  .devices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .devices li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--row);
    padding: 0 4px 0 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .devices .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .devices .seen { font-size: var(--text-xs); flex: none; }
  .danger { color: var(--color-danger); }
</style>
