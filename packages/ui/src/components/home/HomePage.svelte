<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { Inbox, Network, SlidersHorizontal, UserPlus, Users } from '@lucide/svelte';
  import type { ModelTier } from '@boite/contracts';
  import { minuteClock } from '../../lib/clock.svelte';
  import { contactsOf, splitRequests } from '../../lib/contacts.svelte';
  import { count } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';
  import type { Store } from '../../lib/store.svelte';
  import InfoTip from '../InfoTip.svelte';
  import RailFrame from '../RailFrame.svelte';
  import AddContact from './AddContact.svelte';
  import ContactCard from './ContactCard.svelte';
  import RequestCard from './RequestCard.svelte';
  import TailscaleCard from './TailscaleCard.svelte';

  /**
   * Home: the contacts of this machine and everything that links them. The
   * rail beside it, the thread list's own column, lists the sections and how
   * much waits in each; the card is one scroll of them: the requests, the
   * contacts, the way to add one, Tailscale and the contact settings. On a
   * phone the card is the whole screen.
   */
  /*
   * `head` is the rail's switch, drawn by App: imported from this chunk too,
   * RailHead and what it draws would leave the shared boot chunk for the entry.
   */
  let { store, head: railHead }: { store: Store; head?: Snippet } = $props();
  const labels = $derived(strings.contacts);
  const view = $derived(contactsOf(store));
  const now = $derived(minuteClock.now);

  const data = $derived(view.state);
  const requests = $derived(data ? splitRequests(data.requests) : { pending: [], decided: [] });
  const waiting = $derived(requests.pending.filter(request => request.direction === 'in').length);
  const online = $derived(data?.contacts.filter(contact => contact.link === 'connected').length ?? 0);
  const TIERS: ModelTier[] = [1, 2, 3];
  const TIER_NAMES = { 1: 'frontier', 2: 'mid', 3: 'small' } as const satisfies Record<ModelTier, keyof typeof strings.contacts.settings.tiers>;

  type Section = 'requests' | 'contacts' | 'add' | 'tailscale' | 'settings';
  const sections = $derived<{ id: Section; label: string; glyph: typeof Users; count?: string; tone?: 'accent' | 'live' }[]>([
    { id: 'requests', label: labels.nav.requests, glyph: Inbox, ...(waiting ? { count: count(waiting), tone: 'accent' as const } : {}) },
    { id: 'contacts', label: labels.nav.contacts, glyph: Users, ...(data?.contacts.length ? { count: count(data.contacts.length) } : {}) },
    { id: 'add', label: labels.nav.add, glyph: UserPlus },
    { id: 'tailscale', label: labels.nav.tailscale, glyph: Network, ...(data?.tailscale.policy === 'open' ? { count: '!', tone: 'live' as const } : {}) },
    { id: 'settings', label: labels.nav.settings, glyph: SlidersHorizontal }
  ]);
  let current = $state<Section>('requests');
  let scroller = $state<HTMLDivElement>();

  function go(id: Section) {
    current = id;
    const target = scroller?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    const reduced = document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
    target?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }

  onMount(() => view.watch());
  // A reconnection is a new client: follow it and read again.
  $effect(() => { void store.client; view.follow(); });
</script>

<section class="home-page" data-testid="home-page">
  <RailFrame {store} kind="home-rail" label={labels.heading}>
    {#snippet head()}{@render railHead?.()}{/snippet}
    <nav class="home-nav" aria-label={labels.heading}>
      {#each sections as section (section.id)}
        <button type="button" class="home-nav-row" class:on={current === section.id} aria-current={current === section.id ? 'true' : undefined}
          onclick={() => go(section.id)} data-testid="home-nav-{section.id}">
          <section.glyph size={16} strokeWidth={1.75} /><span class="ui-label">{section.label}</span>
          {#if section.count}<span class="home-count" data-tone={section.tone}>{section.count}</span>{/if}
        </button>
      {/each}
    </nav>
  </RailFrame>

  <main class="home-main framed">
    <div class="home-scroll" bind:this={scroller}>
      <div class="home-column">
        <header class="hero">
          <div class="hero-text">
            <h1 class="ui-label-box"><span class="ui-label">{labels.heading}</span><InfoTip topic={labels.heading} text={labels.tip} /></h1>
            {#if data}<p class="self">{fill(labels.self, { machine: data.self.machine })}</p>{/if}
          </div>
          {#if data}
            <div class="stats">
              <span class="stat" data-tone="success" data-testid="home-online"><span class="pip"></span>{fill(labels.online, { count: count(online) })}</span>
              {#if waiting}<span class="stat" data-tone="accent" data-testid="home-waiting"><span class="pip"></span>{fill(labels.waiting, { count: count(waiting) })}</span>{/if}
            </div>
          {/if}
        </header>

        {#if view.error}
          <p class="banner" role="alert" data-testid="home-error">{view.error}<button type="button" class="ghost small" onclick={() => { view.error = ''; }}>{strings.common.close}</button></p>
        {/if}
        {#if data && store.connection !== 'ready'}<p class="banner quiet" role="status">{labels.stale}</p>{/if}

        {#if !data}
          <div class="empty-state">
            <p>{view.loadError ? labels.loadFailed : strings.app.loading}</p>
            {#if view.loadError}<p class="hint">{view.loadError}</p><button type="button" onclick={() => void view.refresh()}>{labels.retry}</button>{/if}
          </div>
        {:else}
          <section class="block" data-section="requests" aria-labelledby="home-requests">
            <h2 id="home-requests" class="block-title">{labels.nav.requests}{#if waiting}<span class="home-count" data-tone="accent">{count(waiting)}</span>{/if}</h2>
            {#if requests.pending.length}
              <div class="stack">
                {#each requests.pending as request (request.id)}<RequestCard {view} {request} {now} />{/each}
              </div>
            {:else}
              <p class="none">{labels.requests.none}</p>
            {/if}
            {#if requests.decided.length}
              <details class="disclosure decided" data-testid="home-decided">
                <summary>{fill(labels.requests.decided, { count: count(requests.decided.length) })}</summary>
                <div class="decided-list">
                  {#each requests.decided as request (request.id)}<RequestCard {view} {request} {now} />{/each}
                </div>
              </details>
            {/if}
          </section>

          <section class="block" data-section="contacts" aria-labelledby="home-contacts">
            <h2 id="home-contacts" class="block-title">{labels.nav.contacts}</h2>
            {#if data.contacts.length}
              <div class="stack">
                {#each data.contacts as contact (contact.coreId)}<ContactCard {view} {contact} {now} />{/each}
              </div>
            {:else}
              <p class="none" data-testid="home-no-contact">{labels.empty}</p>
            {/if}
          </section>

          <section class="block" data-section="add" aria-labelledby="home-add">
            <h2 id="home-add" class="block-title">{labels.nav.add}</h2>
            <AddContact {view} />
          </section>

          <section class="block" data-section="tailscale" aria-labelledby="home-tailscale">
            <h2 id="home-tailscale" class="block-title ui-label-box"><span class="ui-label">{labels.tailscale.title}</span><InfoTip topic={labels.tailscale.title} text={labels.tailscale.tip} /></h2>
            <div class="panel"><TailscaleCard {view} /></div>
          </section>

          <section class="block" data-section="settings" aria-labelledby="home-settings">
            <h2 id="home-settings" class="block-title">{labels.nav.settings}</h2>
            <div class="panel tier-row">
              <span class="ui-label-box tier-label"><span class="ui-label" id="home-tier">{labels.settings.minTier}</span><InfoTip topic={labels.settings.minTier} text={labels.settings.minTierTip} /></span>
              <div class="segmented" role="group" aria-labelledby="home-tier">
                {#each TIERS as tier (tier)}
                  <button type="button" class:on={data.settings.minTier === tier} aria-pressed={data.settings.minTier === tier} disabled={view.isBusy('settings')}
                    onclick={() => { if (data.settings.minTier !== tier) void view.settings({ ...data.settings, minTier: tier }); }} data-testid="home-tier-{tier}">
                    <span class="tier-n">{tier}</span><span class="ui-label">{labels.settings.tiers[TIER_NAMES[tier]]}</span>
                  </button>
                {/each}
              </div>
            </div>
          </section>
        {/if}
      </div>
    </div>
  </main>
</section>

<style>
  .home-page { flex: 1; min-width: 0; min-height: 0; display: flex; }
  @media (min-width: 721px) { .home-page { gap: var(--frame-gap); } }
  .home-nav { display: grid; gap: 2px; padding: 2px 4px; }
  .home-nav-row { justify-content: flex-start; gap: 10px; height: var(--row); padding: 0 10px; border: 0; border-radius: var(--radius-md); background: none; color: var(--color-muted-foreground); font-weight: 500; }
  .home-nav-row:hover, .home-nav-row:focus-visible { background: var(--color-hover); color: var(--color-foreground); outline: none; }
  .home-nav-row.on { background: var(--color-active); color: var(--color-foreground); }
  .home-nav-row .ui-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .home-count { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 6px; border-radius: var(--radius-full); background: var(--color-surface-3); color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; font-variant-numeric: tabular-nums; }
  .home-count[data-tone='accent'] { background: var(--color-accent); color: var(--color-accent-ink); }
  .home-count[data-tone='live'] { background: color-mix(in oklch, var(--color-live) 20%, transparent); color: var(--color-live); }

  .home-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .home-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .home-column { width: min(100%, var(--settings-width)); margin: 0 auto; padding: 28px clamp(16px, 4vw, 40px) 56px; display: grid; gap: 28px; animation: fade var(--dur-2) var(--ease-out-quint); }

  /* The page's head: a violet glow under the title, the one place the accent is laid as light. */
  .hero {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px 20px;
    padding: 22px 22px 20px;
    border: 1px solid color-mix(in oklch, var(--color-accent) 25%, var(--color-border));
    border-radius: var(--radius-xl);
    background:
      radial-gradient(120% 140% at 0% 0%, color-mix(in oklch, var(--color-accent) 26%, transparent), transparent 60%),
      linear-gradient(to bottom right, var(--color-surface-2), var(--color-surface));
    box-shadow: var(--shadow-e1);
    overflow: hidden;
  }
  .hero h1 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: calc(var(--text-lg) * 1.4); font-weight: 700; letter-spacing: -0.01em; line-height: 1.1; }
  .hero-text { display: grid; gap: 6px; min-width: 0; }
  .self { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .stats { display: flex; flex-wrap: wrap; gap: 6px; }
  .stat { --tone: var(--color-success); display: inline-flex; align-items: center; gap: 6px; height: var(--control-sm); padding: 0 10px; border-radius: var(--radius-full); background: color-mix(in oklch, var(--tone) 15%, transparent); color: var(--tone); font-size: var(--text-xs); font-weight: 600; }
  .stat[data-tone='accent'] { --tone: var(--color-accent); }
  .pip { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .stat[data-tone='accent'] .pip { animation: pulse 1.6s var(--ease-out-quint) infinite var(--loops); }

  .banner { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0; padding: 8px 8px 8px 12px; border-radius: var(--radius-md); background: color-mix(in oklch, var(--color-danger) 12%, transparent); color: var(--color-danger); font-size: var(--text-sm); }
  .banner.quiet { background: var(--color-surface-2); color: var(--color-muted-foreground); }
  .empty-state { display: grid; justify-items: center; gap: 10px; padding: 48px 16px; color: var(--color-muted-foreground); text-align: center; }

  .block { display: grid; gap: 12px; min-width: 0; scroll-margin-top: 16px; }
  .block-title { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--color-muted-foreground); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
  .stack { display: grid; gap: 10px; }
  .none { margin: 0; padding: 14px 16px; border: 1px dashed var(--color-edge); border-radius: var(--radius-lg); color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .decided > summary { width: max-content; }
  .decided-list :global(.decided + .decided) { border-top: 1px solid var(--color-border); border-radius: 0; }
  .decided-list { margin-top: 8px; padding: 4px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); }
  .panel { padding: 8px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-e1); }
  .tier-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; }
  .tier-label { display: flex; align-items: center; gap: 4px; font-weight: 500; }
  .segmented { display: flex; gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border); }
  .segmented button { gap: 6px; height: var(--control-sm); padding: 0 12px; border: 0; background: none; color: var(--color-muted-foreground); font-weight: 500; }
  .segmented button:hover:not(:disabled) { color: var(--color-foreground); background: var(--color-hover); }
  .segmented button.on { background: var(--color-active); color: var(--color-foreground); box-shadow: var(--shadow-e1); }
  .tier-n { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 4px; background: var(--color-surface-3); font-size: var(--text-xs); font-weight: 700; font-variant-numeric: tabular-nums; }
  .on .tier-n { background: var(--color-accent); color: var(--color-accent-ink); }
  @media (prefers-reduced-motion: reduce) { .home-column, .stat .pip { animation: none; } }
  :global(html[data-motion='reduced']) .home-column, :global(html[data-motion='reduced']) .stat .pip { animation: none; }

  /* A phone: the card is the screen; the menu leads back to the threads. */
  @media (max-width: 720px) {
    .home-page { flex-direction: column; padding-bottom: env(safe-area-inset-bottom); }
    .home-page :global(.home-rail) { display: none; }
    .home-column { padding: 16px 12px 40px; gap: 22px; }
    .hero { padding: 18px 16px 16px; }
    .hero h1 { font-size: calc(var(--text-lg) * 1.2); }
    .tier-row { padding: 12px; }
    .segmented { width: 100%; }
    .segmented button { flex: 1; min-height: var(--touch-target); padding: 0 6px; }
    .home-nav-row { height: var(--touch-target); }
  }
</style>
