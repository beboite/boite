/*
 * The reactive face of `onboarding.ts`: whether the tour is on screen.
 *
 * It belongs to the window rather than to a machine's store, because that is
 * what it teaches: a device connected to three cores is still one screen, and
 * it goes through the tour once. `onboarding.ts` stays rune-free so the tests
 * and the storage helpers can be imported from anywhere.
 */

import { onboardingSeen, writeOnboarding } from './onboarding';

const mirror = $state<{ open: boolean; seen: boolean }>({ open: false, seen: onboardingSeen() });

/** Asked for from the palette or from Settings, rather than opened on its own. */
export function tourRequested(): boolean {
  return mirror.open;
}

/** Whether this device has already been through it. */
export function tourSeen(): boolean {
  return mirror.seen;
}

/** The same screens as the first launch. Nothing the user has set is undone. */
export function openTour(): void {
  mirror.open = true;
}

/** Finished at the last screen or skipped at the first: the device remembers either way. */
export function closeTour(): void {
  mirror.open = false;
  mirror.seen = true;
  writeOnboarding();
}
