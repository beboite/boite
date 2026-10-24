<script lang="ts">
  import { onMount } from 'svelte';
  import { minuteClock } from '../../lib/clock.svelte';
  import { contactsOf, splitRequests } from '../../lib/contacts.svelte';
  import { count } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';
  import type { Store } from '../../lib/store.svelte';
  import InfoTip from '../InfoTip.svelte';
  import AddContact from './AddContact.svelte';
  import ContactPage from './ContactPage.svelte';
  import ContactSettings from './ContactSettings.svelte';
  import RequestCard from './RequestCard.svelte';

  /**
   * The Contacts page, in the main card beside the thread list, laid out like
   * a Settings page. A contact picked in the list shows its own page; with
   * none, the page shows what waits, the two ways to add a contact, and the
   * Tailscale and model settings.
   */
  let { store }: { store: Store } = $props();
  const labels = $derived(strings.contacts);
  const view = $derived(contactsOf(store));
  const now = $derived(minuteClock.now);

  const data = $derived(view.state);
  const contact = $derived(store.contact ? data?.contacts.find(entry => entry.coreId === store.contact) ?? null : null);
  const requests = $derived(data ? splitRequests(data.requests) : { pending: [], decided: [] });

  onMount(() => view.watch());
  // A reconnection is a new client: follow it and read again.
  $effect(() => { void store.client; void store.connection; view.follow(); });
</script>

<div class="settings contacts" data-testid="home-page">
  <div class="page">
    {#if view.error}
      <p class="banner" role="alert" data-testid="home-error">{view.error}<button type="button" class="ghost small" onclick={() => { view.error = ''; }}>{strings.common.close}</button></p>
    {/if}
    {#if data && store.connection !== 'ready'}<p class="banner quiet" role="status">{labels.stale}</p>{/if}

    {#if !data}
      <p class="hint">{view.loadError ? labels.loadFailed : strings.app.loading}</p>
      {#if view.loadError}<p class="hint">{view.loadError}</p><button type="button" onclick={() => void view.refresh()}>{labels.retry}</button>{/if}
    {:else if contact}
      {#key contact.coreId}<ContactPage {view} {contact} {now} />{/key}
    {:else}
      <header>
        <div>
          <h1 class="ui-label-box"><span class="ui-label">{labels.heading}</span><InfoTip topic={labels.heading} text={labels.tip} /></h1>
          <p>{labels.intro}</p>
        </div>
      </header>

      {#if requests.pending.length || requests.decided.length}
        <section class="card" data-testid="home-requests">
          <h2 class="ui-label-box"><span class="ui-label">{labels.requests.title}</span>{#if requests.pending.length}<span class="count" data-testid="home-waiting">{fill(labels.waiting, { count: count(requests.pending.length) })}</span>{/if}</h2>
          {#each requests.pending as request (request.id)}<RequestCard {view} {request} {now} />{/each}
          {#if requests.decided.length}
            <details class="disclosure decided" data-testid="home-decided">
              <summary>{fill(labels.requests.decided, { count: count(requests.decided.length) })}</summary>
              {#each requests.decided as request (request.id)}<RequestCard {view} {request} {now} />{/each}
            </details>
          {/if}
        </section>
      {/if}

      <section class="card" data-testid="home-add">
        <h2>{labels.add}</h2>
        <AddContact {view} />
      </section>

      <section class="card" data-testid="home-settings">
        <h2>{labels.settings.title}</h2>
        <ContactSettings {view} />
      </section>
    {/if}
  </div>
</div>

<style>
  .contacts { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .contacts .page { flex: 1; min-height: 0; animation: fade var(--dur-2) var(--ease-out-quint); }
  .count { margin-left: 8px; padding: 1px 8px; border-radius: var(--radius-full); background: color-mix(in oklch, var(--color-live) 18%, transparent); color: var(--color-live); font-size: var(--text-xs); font-weight: 600; }
  .banner { display: flex; align-items: center; justify-content: space-between; gap: 10px; max-width: var(--settings-width); margin: 0 0 16px; padding: 8px 8px 8px 12px; border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-danger) 12%, transparent); color: var(--color-danger); font-size: var(--text-sm); }
  .banner.quiet { background: var(--color-surface-2); color: var(--color-muted-foreground); }
  .decided { margin-top: 4px; }
  .decided > summary { width: max-content; }
  @media (prefers-reduced-motion: reduce) { .contacts .page { animation: none; } }
  :global(html[data-motion='reduced']) .contacts .page { animation: none; }
  @media (max-width: 720px) {
    .contacts :global(.page) { padding: 20px 14px 40px; }
  }
</style>
