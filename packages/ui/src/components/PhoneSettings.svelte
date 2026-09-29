<script lang="ts">
  import InfoTip from './InfoTip.svelte';
  import { untrack } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { installApp, installed, PUSH_ENABLED_KEY, worker } from '../lib/pwa';
  let { store, showServerSettings = true }: { store: Store; showServerSettings?: boolean } = $props();
  const uid = $props.id();
  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  const secure = window.isSecureContext;
  const capable = secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let standalone = $state(installed());
  let publicUrl = $state(untrack(() => store.settings?.publicUrl ?? ''));
  let key = $state('');
  let subscribed = $state(false);
  let busy = $state(false);
  let message = $state('');
  let error = $state('');
  let ownOrigin = $derived(!store.endpointUrl || new URL(store.endpointUrl).origin === location.origin);
  let paired = $derived(store.sessions.some(session => session.current));

  $effect(() => {
    if (inShell || !paired || !ownOrigin || store.connection !== 'ready') return;
    let live = true;
    void store.client?.call('push.status', {}).then(result => {
      if (!live) return;
      key = result.publicKey;
      subscribed = result.subscribed;
      if (!subscribed) localStorage.removeItem(PUSH_ENABLED_KEY);
    }).catch(reason => { if (live) error = String(reason); });
    return () => { live = false; };
  });

  async function enable() {
    if (!capable || !key || !store.client) return;
    // Safari requires the permission request directly in this click, before any await.
    const permission = Notification.requestPermission();
    busy = true; error = ''; message = '';
    try {
      if (await permission !== 'granted') throw new Error(strings.phone.denied);
      const registration = await worker();
      let subscription = await registration.pushManager.getSubscription();
      const existingKey = subscription?.options.applicationServerKey;
      const expectedKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
      if (subscription && (!existingKey || new Uint8Array(existingKey).some((byte, index) => byte !== expectedKey[index]) || existingKey.byteLength !== expectedKey.length)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error(strings.phone.subscriptionFailed);
      await store.client.call('push.subscribe', { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      subscribed = true;
      localStorage.setItem(PUSH_ENABLED_KEY, 'on');
      message = strings.phone.enabled;
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; }
  }
  async function disable() {
    if (!store.client) return;
    busy = true; error = ''; message = '';
    try {
      await store.client.call('push.unsubscribe', {});
      subscribed = false;
      localStorage.removeItem(PUSH_ENABLED_KEY);
      const registration = await navigator.serviceWorker.getRegistration('/');
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; }
  }
  async function testPush() {
    busy = true; error = ''; message = '';
    try { await store.client?.call('push.test', {}); message = strings.phone.testSent; }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; }
  }
</script>

<section class="card" id="settings-phone" data-testid="phone-settings">
  <h2>{strings.phone.heading}</h2>
  {#if store.owner && showServerSettings}
    <div class="block">
      <label for="{uid}-public-url"><span><span id="{uid}-public-url-name">{strings.phone.publicUrl}</span><InfoTip topic={strings.phone.publicUrl} text={strings.phone.publicUrlHint} /></span><input id="{uid}-public-url" aria-labelledby="{uid}-public-url-name" type="url" bind:value={publicUrl} placeholder={strings.phone.urlPlaceholder} data-testid="phone-public-url" /></label>
      <div class="actions">
        <button disabled={store.connection !== 'ready'} onclick={() => void store.saveSettings({ publicUrl: publicUrl.trim() || null })}>{strings.settings.save}</button>
      </div>
    </div>
  {/if}
  {#if !inShell}
    <div class="block">
      {#if standalone}<p class="hint">{strings.phone.installed}</p>
      {:else}
        <div class="actions">
          <button onclick={async () => { standalone = await installApp() || installed(); if (!standalone) message = strings.phone.installHint; }}>{strings.phone.install}</button>
          <InfoTip topic={strings.phone.install} text={strings.phone.installHint} />
        </div>
      {/if}
    </div>
    <div class="block">
      {#if !secure}<p class="hint">{strings.phone.httpsRequired}</p>
      {:else if !ownOrigin}<p class="hint">{strings.phone.ownOrigin}</p>
      {:else if !paired}<p class="hint">{strings.phone.pairFirst}</p>
      {:else if !capable}<p class="hint">{strings.phone.unsupported}</p>
      {:else}
        <div class="actions">
          <InfoTip topic={strings.phone.heading} text={strings.phone.pushHint} />
          {#if subscribed}
            <button disabled={busy} onclick={disable}>{strings.phone.disable}</button>
            <button disabled={busy} onclick={testPush}>{strings.phone.test}</button>
          {:else}<button disabled={busy || !key} onclick={enable}>{strings.phone.enable}</button>{/if}
        </div>
      {/if}
      {#if message}<p class="hint" role="status">{message}</p>{/if}
      {#if error}<p class="hint" role="alert">{error}</p>{/if}
    </div>
  {/if}
</section>

<style>
  /* One block per subject, separated like the rows of the other cards: the
     field or the sentence first, its buttons under it. */
  .block { display: flex; flex-direction: column; gap: 10px; }
  .block + .block { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--color-border); }
  label { display: flex; flex-direction: column; gap: 6px; }
  label > span { margin: 0; }
  input { width: 100%; }
  [role='alert'] { color: var(--color-danger); }
</style>
