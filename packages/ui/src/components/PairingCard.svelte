<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import type { PairedSession } from '@boite/contracts';
  import { confirm } from '../lib/confirm.svelte';
  import { ago, time } from '../lib/format';
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

  // The QR code follows the minted link: a new link redraws it, no link clears it.
  let qr = $state('');
  $effect(() => {
    const url = store.pairing?.url;
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
</script>

<section class="card" id="settings-devices" data-testid="pairing-card">
  <h2>{strings.settings.pairing.heading}<InfoTip topic={strings.settings.pairing.heading} text={strings.settings.pairing.intro} /></h2>
  {#if store.principal === 'owner'}
    <label for="{uid}-listen-on-lan" class="switch-row">
      <span class="text">
        <span id="{uid}-listen-on-lan-name">{strings.settings.listenOnLan}</span><InfoTip topic={strings.settings.listenOnLan} text={strings.settings.listenOnLanHint} />
      </span>
      <input id="{uid}-listen-on-lan" aria-labelledby="{uid}-listen-on-lan-name" type="checkbox" role="switch" data-testid="setting-listen-on-lan"
        checked={store.settings?.listenOnLan ?? false} disabled={!store.settings}
        onchange={(event) => void toggleLan(event.currentTarget)} />
    </label>
    <label for="{uid}-pairing-owner" class="switch-row">
      <span class="text">
        <span id="{uid}-pairing-owner-name">{strings.settings.pairing.owner}</span><InfoTip topic={strings.settings.pairing.owner} text={strings.settings.pairing.ownerHint} />
      </span>
      <input id="{uid}-pairing-owner" aria-labelledby="{uid}-pairing-owner-name" type="checkbox" role="switch" data-testid="pairing-owner" bind:checked={ownerLink} />
    </label>
    <div class="actions">
      <button type="button" class="primary" data-testid="pairing-mint" onclick={() => void store.mintPairing(ownerLink ? 'owner' : 'device')}>
        {strings.settings.pairing.mint}
      </button>
      {#if store.pairing}
        <button type="button" onclick={() => void store.copy(store.pairing?.url ?? '')}>{strings.settings.pairing.copy}</button>
      {/if}
    </div>
    {#if store.pairing}
      <div class="minted">
        <!-- A computer takes the link pasted, so its QR code would only be
             a camera away from the wrong device. -->
        {#if qr && store.pairing.role !== 'owner'}
          <div class="qr" data-testid="pairing-qr" aria-label={strings.settings.pairing.qr}>{@html qr}</div>
        {/if}
        <div class="minted-text">
          <p class="mono link" data-testid="pairing-link">{store.pairing.url}</p>
          <p class="hint">{store.pairing.role === 'owner' ? strings.settings.pairing.pasteOwner : strings.settings.pairing.scan}</p>
          <p class="hint">{fill(strings.settings.pairing.expires, { time: time(store.pairing.expiresAt) })}</p>
          {#if store.pairing.role !== 'owner' && store.settings && !store.settings.listenOnLan}
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
            {session.client.name} {session.client.version}
            {#if session.role === 'owner'}<span class="subtle">({strings.settings.pairing.ownerTag})</span>{/if}
            {#if session.current}<span class="subtle">({strings.settings.pairing.thisDevice})</span>{/if}
          </span>
          <span class="subtle seen">{fill(strings.settings.pairing.lastSeen, { when: ago(session.lastSeenAt) })}</span>
          {#if store.principal === 'owner'}
            <button type="button" class="ghost small danger" onclick={() => void revoke(session)}>{strings.settings.pairing.revoke}</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .actions { margin-top: 4px; }
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
