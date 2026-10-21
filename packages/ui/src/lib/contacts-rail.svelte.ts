/*
 * The contacts column on the window's right edge: whether it is folded, kept
 * on this device, and what waits in it, so the title bar's button can say so
 * while the column is folded. The column itself loads with its experiment.
 */

import { experimentOn } from './experiments.svelte';

/**
 * Whether this machine's contacts have a way in: the experiment is on and the
 * client is the owner. A paired device may call none of `contacts.*`.
 */
export function contactsShown(store: { owner: boolean }): boolean {
  return experimentOn('contacts') && store.owner;
}

/** The column's width; the right panel leaves it this much room. */
export const CONTACTS_RAIL_WIDTH = 240;
const FOLDED = 'boite.contacts-rail-folded';

/** Folded until the owner unfolds it: the title bar's button says when something waits. */
function readFolded(): boolean {
  try { return localStorage.getItem(FOLDED) !== '0'; } catch { return true; }
}

class ContactsRail {
  folded = $state(readFolded());
  /** Requests waiting on every listed machine, counted by the column while it is drawn. */
  waiting = $state(0);

  /** Unfolded for this machine's owner; App draws it only on a desktop-wide window. */
  shown(store: { owner: boolean }): boolean {
    return contactsShown(store) && !this.folded;
  }

  toggle(): void {
    this.folded = !this.folded;
    try { localStorage.setItem(FOLDED, this.folded ? '1' : '0'); } catch { /* A private window keeps it for the session. */ }
  }
}

export const contactsRail = new ContactsRail();
