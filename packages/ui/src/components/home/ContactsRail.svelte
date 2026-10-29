<script lang="ts">
  import { onMount } from 'svelte';
  import { House, UserPlus } from '@lucide/svelte';
  import { contactRows, initialsOf, openContact, watchContacts } from '../../lib/contacts.svelte';
  import { contactsRail } from '../../lib/contacts-rail.svelte';
  import { count } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';
  import type { Store } from '../../lib/store.svelte';
  import { workspace } from '../../lib/workspace.svelte';

  /**
   * The contacts on the window's right edge, the projects keeping the left
   * one: one row per contact of every listed machine, with its link and what
   * it asks. A row opens the contact's page in the main card; the title opens
   * the Contacts page (requests, adding one, Tailscale) and Add the same page.
   * The title bar's button folds the column, which stays mounted so the button
   * can still count what waits. It slides in when unfolded, not each time it
   * is drawn: a column open at startup is simply there.
   */
  let { store }: { store: Store } = $props();
  const labels = $derived(strings.contacts);
  const machines = $derived(workspace.machinesOr(store));

  const watched = watchContacts(() => machines);
  const rows = $derived(contactRows(watched()));
  $effect(() => { contactsRail.waiting = rows.reduce((sum, row) => sum + row.waiting, 0); });
  $effect(() => () => { contactsRail.waiting = 0; });

  const show = (owner: Store, coreId: string | null) => void openContact(owner, coreId);
  const home = $derived(store.page === 'home' && !store.contact);

  // Two frames: the first style the column gets is without `drawn`, so it starts in place.
  let drawn = $state(false);
  onMount(() => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { drawn = true; }); });
    return () => cancelAnimationFrame(frame);
  });
</script>

<aside class="contacts-rail" class:collapsed={contactsRail.folded} class:drawn inert={contactsRail.folded} aria-label={labels.heading} data-testid="contacts-rail">
  <div class="head">
    <button type="button" class="ghost home" class:active={home} aria-current={home ? 'page' : undefined} title={labels.rail.home}
      onclick={() => show(store, null)} data-testid="contacts-rail-home"><House size={15} /><span class="title ui-label">{labels.heading}</span></button>
    <button type="button" class="ghost icon" title={labels.add} aria-label={labels.add}
      onclick={() => show(store, null)} data-testid="contacts-rail-add"><UserPlus size={16} /></button>
  </div>
  <div class="scroll">
    {#each rows as { machine, contact, waiting: asks } (`${machine.id}:${contact.coreId}`)}
      {@const current = machine.store === workspace.active && store.page === 'home' && store.contact === contact.coreId}
      <button type="button" class="ghost row" class:current aria-current={current ? 'page' : undefined} data-link={contact.link}
        onclick={() => show(machine.store, contact.coreId)} data-testid="rail-contact" data-core-id={contact.coreId}>
        <span class="avatar" aria-hidden="true">{initialsOf(contact.name)}<span class="dot"></span></span>
        <span class="text">
          <span class="name">{contact.name}</span>
          {#if asks}<span class="state asks">{fill(labels.waiting, { count: count(asks) })}</span>
          {:else}<span class="state">{labels.link[contact.link]}</span>{/if}
        </span>
      </button>
    {:else}
      <button type="button" class="ghost row empty" onclick={() => show(store, null)} data-testid="contacts-rail-empty">
        <span class="avatar add" aria-hidden="true"><UserPlus size={14} /></span>
        <span class="text"><span class="name">{labels.add}</span><span class="state">{labels.tip}</span></span>
      </button>
    {/each}
  </div>
</aside>

<style>
  /* The thread list's twin on the other edge: it stands on the frame, no card,
     and folds by sliding out past the window's right edge. */
  .contacts-rail {
    --rail-width: 240px;
    --slide-room: calc(var(--rail-width) + var(--frame-gap));
    display: flex;
    flex: none;
    flex-direction: column;
    width: var(--rail-width);
    min-height: 0;
    margin-right: calc(-1 * var(--frame-gap));
    transition: margin-right var(--dur-slide) var(--ease-slide), opacity var(--dur-3) var(--ease-out-quint), display var(--dur-slide) allow-discrete;
  }
  .contacts-rail.collapsed {
    display: none;
    pointer-events: none;
    opacity: 0;
    margin-right: calc(-1 * var(--slide-room));
    transition: margin-right var(--dur-slide-out) var(--ease-slide), opacity var(--dur-2) var(--ease-out-quint), display var(--dur-slide-out) allow-discrete;
  }
  @starting-style { .contacts-rail.drawn:not(.collapsed) { opacity: 0; margin-right: calc(-1 * var(--slide-room)); } }
  .head { display: flex; align-items: center; gap: 6px; height: var(--control-lg); margin: 0 10px 0 6px; }
  .home { flex: 1; min-width: 0; justify-content: flex-start; gap: 8px; padding: 0 10px; color: var(--color-muted-foreground); }
  .home:hover:not(:disabled), .home.active { color: var(--color-foreground); }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); font-weight: 600; }
  .head button { flex: none; }
  .head .home { flex: 1; }
  .head button.active { background: var(--color-active); color: var(--color-foreground); }
  .scroll { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; padding: 6px 10px 10px 6px; }
  /* A button is one control tall by default: a row grows with its two lines, the empty row with its wrapped tip. */
  .row { --tone: var(--color-subtle); display: flex; flex: none; align-items: center; justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-height: 44px; padding: 4px 10px; border-radius: var(--radius-md); background: transparent; text-align: left; }
  .row:hover:not(:disabled) { background: var(--color-hover); }
  .row:active:not(:disabled) { transform: none; }
  .row.current { background: var(--color-active); }
  .row[data-link='connected'] { --tone: var(--color-success); }
  .row[data-link='connecting'] { --tone: var(--color-live); }
  .avatar { position: relative; display: grid; flex: none; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.02em; }
  .avatar.add { background: var(--color-surface-2); color: var(--color-muted-foreground); }
  .dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 2px var(--color-frame); }
  .text { display: flex; flex: 1; flex-direction: column; min-width: 0; line-height: 1.25; }
  .name, .state { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name { color: var(--color-foreground); font-size: var(--text-sm); font-weight: 500; }
  .state { color: var(--color-subtle); font-size: var(--text-xs); }
  .state.asks { color: var(--color-live); font-weight: 500; }
  .empty .state { white-space: normal; }
  @media (prefers-reduced-motion: reduce) { .contacts-rail, .contacts-rail.collapsed { transition: none; } }
  :global(html[data-motion='reduced']) .contacts-rail, :global(html[data-motion='reduced']) .contacts-rail.collapsed { transition: none; }
</style>
