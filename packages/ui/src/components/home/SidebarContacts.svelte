<script lang="ts">
  import { ChevronRight, UserPlus, Users } from '@lucide/svelte';
  import { contactRows, initialsOf, openContact, watchContacts } from '../../lib/contacts.svelte';
  import { count } from '../../lib/format';
  import { fill, strings } from '../../lib/strings';
  import type { Store } from '../../lib/store.svelte';
  import { workspace, type Machine } from '../../lib/workspace.svelte';

  /**
   * The contacts in a phone's list, under the projects: a section like a
   * project's, one row per contact with its link and what it asks, and Add
   * beside the title. A row opens the contact's page. Every listed machine's
   * contacts show; the section folds, and remembers it. A desktop window
   * shows them in the column on the right instead (ContactsRail).
   */
  let { store, machines }: { store: Store; machines: Machine[] } = $props();
  const labels = $derived(strings.contacts);
  const FOLDED = 'boite.contacts-folded';

  let open = $state(readOpen());
  function readOpen(): boolean {
    try { return localStorage.getItem(FOLDED) !== '1'; } catch { return true; }
  }
  function toggle() {
    open = !open;
    try { localStorage.setItem(FOLDED, open ? '0' : '1'); } catch { /* A private window keeps it for the session. */ }
  }

  const watched = watchContacts(() => machines);
  const rows = $derived(contactRows(watched()));
  const waiting = $derived(rows.reduce((sum, row) => sum + row.waiting, 0));
  const show = (owner: Store, coreId: string | null) => void openContact(owner, coreId);
</script>

<section class="contacts" data-testid="sidebar-contacts">
  <div class="head">
    <button type="button" class="ghost toggle" aria-expanded={open} onclick={toggle} data-testid="sidebar-contacts-toggle">
      <span class="mark"><Users size={16} strokeWidth={1.75} /><span class="fold-caret" class:open aria-hidden="true"><ChevronRight size={16} /></span></span>
      <span class="title ui-label">{labels.heading}</span>
      <!-- Folded, the title alone says something waits; open, the rows say it. -->
      {#if waiting && !open}<span class="waiting ui-label" data-testid="sidebar-contacts-waiting" title={fill(labels.waiting, { count: count(waiting) })}>{count(waiting)}</span>{/if}
    </button>
    <button type="button" class="ghost small icon add" title={labels.add} aria-label={labels.add} onclick={() => show(store, null)} data-testid="sidebar-contacts-add"><UserPlus size={15} /></button>
  </div>
  <div class="disclosure-fold" class:open inert={!open}>
    <div>
      {#each rows as { machine, contact, waiting: asks } (`${machine.id}:${contact.coreId}`)}
        {@const current = machine.store === workspace.active && store.page === 'home' && store.contact === contact.coreId}
        <button type="button" class="ghost row" class:current aria-current={current ? 'page' : undefined} data-link={contact.link}
          onclick={() => show(machine.store, contact.coreId)} data-testid="sidebar-contact" data-core-id={contact.coreId}>
          <span class="avatar" aria-hidden="true">{initialsOf(contact.name).slice(0, 1)}<span class="dot"></span></span>
          <span class="name">{contact.name}</span>
          {#if asks}<span class="state asks">{fill(labels.waiting, { count: count(asks) })}</span>
          {:else if contact.link !== 'connected'}<span class="state">{labels.link[contact.link]}</span>{/if}
        </button>
      {:else}
        <button type="button" class="ghost row empty" onclick={() => show(store, null)} data-testid="sidebar-contacts-empty">
          <UserPlus size={14} /><span class="name">{labels.add}</span>
        </button>
      {/each}
    </div>
  </div>
</section>

<style>
  /* The frame of a project section in Sidebar.svelte, so the two read as one list. */
  .contacts {
    margin-bottom: 10px;
    padding: 4px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--color-surface-2) 55%, transparent);
  }
  .head { display: flex; align-items: center; gap: 2px; }
  .toggle { flex: 1; min-width: 0; height: var(--control-lg); padding: 0 4px; justify-content: flex-start; gap: 6px; }
  .mark { display: grid; flex: none; place-items: center; width: 22px; color: var(--color-muted-foreground); }
  .mark > :global(*) { grid-area: 1 / 1; transition: opacity var(--dur-2) var(--ease-out-quint), transform var(--dur-2) var(--ease-out-quint); }
  .mark .fold-caret { opacity: 0; }
  @media (hover: hover) {
    .head:hover .mark > :global(svg) { opacity: 0; }
    .head:hover .mark .fold-caret { opacity: 1; }
  }
  .toggle:focus-visible .mark > :global(svg) { opacity: 0; }
  .toggle:focus-visible .mark .fold-caret { opacity: 1; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: left; white-space: nowrap; font-weight: 600; color: var(--color-foreground); }
  .waiting { flex: none; padding: 0 6px; border-radius: var(--radius-full); background: color-mix(in oklch, var(--color-live) 18%, transparent); color: var(--color-live); font-size: var(--text-xs); font-weight: 600; font-variant-numeric: tabular-nums; }
  .add { flex: none; opacity: 0; }
  .head:hover .add, .head:focus-within .add { opacity: 1; }
  .row { --tone: var(--color-subtle); display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; min-height: var(--row); padding: 0 10px; border-radius: var(--radius-md); background: transparent; }
  .row:hover:not(:disabled) { background: var(--color-hover); }
  .row:active:not(:disabled) { transform: none; }
  .row.current { background: var(--color-active); }
  .row[data-link='connected'] { --tone: var(--color-success); }
  .row[data-link='connecting'] { --tone: var(--color-live); }
  .avatar { position: relative; display: grid; flex: none; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-xs); font-weight: 700; }
  .dot { position: absolute; right: -1px; bottom: -1px; width: 7px; height: 7px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 2px var(--color-surface); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; color: var(--color-foreground); }
  .state { flex: none; color: var(--color-subtle); font-size: var(--text-xs); }
  .state.asks { color: var(--color-live); font-weight: 500; }
  .empty { color: var(--color-muted-foreground); }
  .empty .name { color: inherit; }
  @media (prefers-reduced-motion: reduce) { .mark > :global(*) { transition: none; } }
  :global(html[data-motion='reduced']) .mark > :global(*) { transition: none; }
  /* A phone's list draws a project as a card under a shaded heading: the section follows it. */
  @media (max-width: 720px) {
    .contacts { margin-bottom: 12px; padding: 0; background: var(--color-surface); overflow: hidden; }
    .head { padding-right: 4px; border-bottom: 1px solid var(--color-border); background: var(--color-surface-2); }
    .toggle { padding: 0 12px; }
    .title { color: var(--color-muted-foreground); font-size: var(--text-sm); }
    .add { opacity: 1; }
    .row { padding: 0 12px; border-radius: 0; }
    .row + .row { border-top: 1px solid var(--color-border); }
  }
</style>
