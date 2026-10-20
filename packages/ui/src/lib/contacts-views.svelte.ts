/*
 * The Contacts page and the contacts column on the right, as App draws them.
 * Each loads once something shows it, so the boot bundle carries neither.
 */

import { contactsShown } from './contacts-rail.svelte';
import { experimentOn } from './experiments.svelte';
import { strings } from './strings';

export { contactsShown };

type Machine = { owner: boolean; page: string; showChat(): void };

/**
 * Loads the page while a machine shows it and the column on a desktop-wide
 * window, and sends a machine whose contacts went away (the experiment
 * turned off, a paired device) from their page back to the chat. Call it
 * while the component starts: its effects live as long as the component.
 */
export function contactsViews(current: () => Machine, machines: () => readonly { store: Machine }[], narrow: () => boolean) {
  const views = $state<{
    HomePage?: typeof import('../components/home/HomePage.svelte').default;
    ContactsRail?: typeof import('../components/home/ContactsRail.svelte').default;
    homeError: string;
  }>({ homeError: '' });
  $effect(() => {
    if (current().page !== 'home' || !experimentOn('contacts') || views.HomePage) return;
    void import('../components/home/HomePage.svelte').then(module => { views.HomePage = module.default; })
      .catch(() => { views.homeError = strings.contacts.loadFailed; });
  });
  $effect(() => {
    if (!contactsShown(current()) || narrow() || views.ContactsRail) return;
    void import('../components/home/ContactsRail.svelte').then(module => { views.ContactsRail = module.default; }).catch(() => {});
  });
  $effect(() => {
    for (const machine of machines()) if (machine.store.page === 'home' && !contactsShown(machine.store)) machine.store.showChat();
    const store = current();
    if (store.page === 'home' && !contactsShown(store)) store.showChat();
  });
  return views;
}
