<script lang="ts">
  import { lockedBy } from '../lib/policy';
  import FirewallNotice from './FirewallNotice.svelte';
  import { errorText } from '../lib/errors';
  import InfoTip from './InfoTip.svelte';
  import SaveStatus from './SaveStatus.svelte';
  import { Autosave, saved, typed } from '../lib/autosave.svelte';
  import NotificationKinds from './NotificationKinds.svelte';
  import LanReach from './LanReach.svelte';
  import TailscaleAccess from './TailscaleAccess.svelte';
  import PolicyLock from './PolicyLock.svelte';
  import { untrack } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { installApp, installed, PUSH_ENABLED_KEY, worker } from '../lib/pwa';
  import { pushKinds, readPushHome, sameKinds, writePushHome } from '../lib/notify';
  import { checkSettingsPatch, parseGroupRelayUrl } from '@boite/contracts';
  import { servesThisPage } from '../lib/endpoint';
  import { appPage } from '../lib/app-origin';
  let { store, showServerSettings = true }: { store: Store; showServerSettings?: boolean } = $props();
  const uid = $props.id();
  const lanLocked = $derived(lockedBy(store.policy, 'network.lan') !== null);
  const pushLocked = $derived(lockedBy(store.policy, 'network.push') !== null);
  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  const secure = window.isSecureContext;
  const capable = secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let standalone = $state(installed());
  let publicUrl = $state(untrack(() => store.settings?.publicUrl ?? ''));
  // The field follows the saved value, which the Tailscale switch can change
  // too. Any other setting replaces the settings object without touching it:
  // an address being typed stays. So does one typed while this field's own
  // save was on its way: that save coming back is not a value from elsewhere.
  const savedUrl = $derived(store.settings?.publicUrl ?? '');
  /** The addresses this field sent, as the core stores them. */
  const sent = new Set<string>();
  $effect(() => {
    const next = savedUrl;
    untrack(() => { if (!sent.delete(next)) publicUrl = next; });
  });
  const urlCheck = () => checkSettingsPatch({ publicUrl: publicUrl.trim() || null });
  const urlSave = new Autosave(async () => {
    const check = urlCheck();
    const stored = check.ok ? check.patch.publicUrl ?? '' : '';
    // Saving what is already saved changes no setting, so no echo comes back to skip.
    if (stored !== savedUrl) sent.add(stored);
    try { await saved(store.saveSettings({ publicUrl: publicUrl.trim() || null })); }
    catch (error) { sent.delete(stored); throw error; }
  }, () => urlCheck().ok ? null : strings.settings.autosave.invalid);
  $effect(() => () => void urlSave.flush());
  let key = $state('');
  let subscribed = $state(false);
  let busy = $state(false);
  let message = $state('');
  let error = $state('');
  // A machine reached through this page's core shares its origin and is not it: its notifications come through that core.
  let relayed = $derived.by(() => {
    const relay = store.endpointUrl === null ? null : parseGroupRelayUrl(store.endpointUrl);
    return relay !== null && servesThisPage(relay.member);
  });
  // The phone app's page is no machine's: the machine it shows takes its notifications and passes on the others'.
  let ownOrigin = $derived(appPage() || !store.endpointUrl || servesThisPage(store.endpointUrl));
  let paired = $derived(store.sessions.some(session => session.current));

  $effect(() => {
    if (inShell || !paired || !ownOrigin || store.connection !== 'ready') return;
    let live = true;
    void store.client?.call('push.status', {}).then(result => {
      if (!live) return;
      key = result.publicKey;
      subscribed = result.subscribed;
      const here = store.endpointUrl ?? '';
      const home = readPushHome();
      // Another machine holding this device's subscription says nothing of it here.
      if (!subscribed) { if (home === null || home === here) { localStorage.removeItem(PUSH_ENABLED_KEY); writePushHome(false); } }
      else {
        writePushHome(here);
        // A choice made while this core was out of reach, or a subscription older than kinds: the device's choice wins.
        if (!sameKinds(result.kinds ?? [], pushKinds())) void store.client?.call('push.kinds', { kinds: pushKinds() }).catch(() => undefined);
      }
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
      await store.client.call('push.subscribe', { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, kinds: pushKinds() });
      subscribed = true;
      localStorage.setItem(PUSH_ENABLED_KEY, 'on');
      writePushHome(store.endpointUrl);
      message = strings.phone.enabled;
    } catch (reason) { error = errorText(reason); }
    finally { busy = false; }
  }
  async function disable() {
    if (!store.client) return;
    busy = true; error = ''; message = '';
    try {
      await store.client.call('push.unsubscribe', {});
      subscribed = false;
      localStorage.removeItem(PUSH_ENABLED_KEY);
      writePushHome(false);
      const registration = await navigator.serviceWorker.getRegistration('/');
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
    } catch (reason) { error = errorText(reason); }
    finally { busy = false; }
  }
  let firewall: FirewallNotice | undefined = $state();
  let reach: LanReach | undefined = $state();
  let restarting = $state(false);
  /**
   * The core reads this when it starts: turning it on asks Windows for its
   * firewall rule while the owner is looking, then the desktop app restarts
   * its core either way. A refusal puts the switch back.
   */
  async function toggleLan(input: HTMLInputElement) {
    const ok = await store.saveSettings({ listenOnLan: input.checked });
    if (!ok) {
      input.checked = store.settings?.listenOnLan ?? !input.checked;
      return;
    }
    if (input.checked) await firewall?.allow();
    await reach?.restart(store.deviceInvite !== null);
  }

  async function testPush() {
    busy = true; error = ''; message = '';
    try { await store.client?.call('push.test', {}); message = strings.phone.testSent; }
    catch (reason) { error = errorText(reason); }
    finally { busy = false; }
  }
</script>

<section class="card" id="settings-phone" data-testid="phone-settings">
  <h2>{strings.phone.heading}<SaveStatus save={urlSave} /></h2>
  {#if store.owner && showServerSettings}
    <div class="block"><TailscaleAccess {store} /></div>
    <div class="block">
      <label for="{uid}-listen-on-lan" class="switch-row">
        <span class="text ui-label-box">
          <span class="ui-label" id="{uid}-listen-on-lan-name">{strings.settings.listenOnLan}</span><InfoTip topic={strings.settings.listenOnLan} text={strings.settings.listenOnLanHint} /><PolicyLock {store} keys={['network.lan']} />
        </span>
        <input id="{uid}-listen-on-lan" aria-labelledby="{uid}-listen-on-lan-name" type="checkbox" role="switch" data-testid="setting-listen-on-lan"
          checked={store.settings?.listenOnLan ?? false} disabled={!store.settings || restarting || lanLocked}
          onchange={(event) => void toggleLan(event.currentTarget)} />
      </label>
      <LanReach {store} loopback={false} {firewall} bind:this={reach} bind:restarting />
      <FirewallNotice {store} bind:this={firewall} />
    </div>
    <!-- A reverse proxy of one's own: what the Tailscale switch above does without typing anything. -->
    <div class="block"><details class="disclosure" data-testid="phone-own-address">
      <summary>{strings.phone.ownAddress}</summary>
      <div class="fields">
      <label for="{uid}-public-url"><span class="ui-label-box"><span class="ui-label" id="{uid}-public-url-name">{strings.phone.publicUrl}</span><InfoTip topic={strings.phone.publicUrl} text={strings.phone.publicUrlHint} /></span><input id="{uid}-public-url" aria-labelledby="{uid}-public-url-name" type="url" bind:value={publicUrl} disabled={store.connection !== 'ready'} placeholder={strings.phone.urlPlaceholder} data-testid="phone-public-url" {...typed(urlSave)} /></label>
      </div>
    </details></div>
  {/if}
  {#if !inShell}
    <!-- The phone's screen: the desktop has these rows under General's switch. -->
    {#if !showServerSettings}<div class="block" data-testid="phone-notification-kinds"><NotificationKinds {store} mobile /></div>{/if}
    <div class="block">
      {#if standalone}<p class="hint">{strings.phone.installed}</p>
      {:else}
        <div class="actions">
          <button onclick={async () => { standalone = await installApp() || installed(); if (!standalone) message = strings.phone.installHint; }}><span class="ui-label">{strings.phone.install}</span></button>
          <InfoTip topic={strings.phone.install} text={strings.phone.installHint} />
        </div>
      {/if}
    </div>
    <div class="block">
      {#if !secure}<p class="hint">{strings.phone.httpsRequired}</p>
      {:else if relayed}<p class="hint" data-testid="phone-relayed">{strings.phone.relayed}</p>
      {:else if !ownOrigin}<p class="hint">{strings.phone.ownOrigin}</p>
      {:else if !paired}<p class="hint">{strings.phone.pairFirst}</p>
      {:else if !capable}<p class="hint">{strings.phone.unsupported}</p>
      {:else}
        <div class="actions">
          <InfoTip topic={strings.phone.heading} text={strings.phone.pushHint} />
          {#if subscribed}
            <button disabled={busy} onclick={disable}><span class="ui-label">{strings.phone.disable}</span></button>
            <button disabled={busy || pushLocked} data-testid="phone-push-test" onclick={testPush}><span class="ui-label">{strings.phone.test}</span></button>
          {:else}<button disabled={busy || !key || pushLocked} data-testid="phone-push-enable" onclick={enable}><span class="ui-label">{strings.phone.enable}</span></button>{/if}
          <PolicyLock {store} keys={['network.push']} />
        </div>
        {#if subscribed}<p class="hint" data-testid="phone-multi-machine">{strings.phone.multiMachine}</p>{/if}
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
  .fields { display: flex; flex-direction: column; gap: 10px; padding-top: 10px; }
  /* A field's label sits over its input. The LAN switch's row is the shared
     `.switch-row` (app.css): a column there turned the switch's 40 px flex
     basis into its height and drew it as a 40 px circle. */
  label:not(.switch-row) { display: flex; flex-direction: column; gap: 6px; }
  label > span { margin: 0; }
  input:not([role='switch']) { width: 100%; }
  [role='alert'] { color: var(--color-danger); }
</style>
