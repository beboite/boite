import { LazyComponent } from './lazy-component.svelte';

/**
 * The phone's navigation, drawn only outside the shell, which never parses it:
 * App fetches it with the app there and the boot screen waits for it, so the
 * first frame has it. Not among the `parts` of `deferred-parts.ts`: the idle
 * prefetch has no use for it, and `Deferred.svelte`, which the navigation's own
 * header draws, would reach it again through that registry.
 */
export const mobileNavigation = new LazyComponent(() => import('../components/MobileNavigation.svelte'));
