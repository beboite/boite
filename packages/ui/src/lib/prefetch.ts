import type { Store } from './store.svelte';

/**
 * The idle prefetch of the chunks the first screen does not draw (App.svelte).
 * Each chunk still loads the moment it is asked for; this only decides what is
 * fetched ahead, and when.
 */

interface Link {
  saveData?: boolean;
  effectiveType?: string;
}

/** A data saver or a slow link keeps its bytes for what the user opens. */
export function prefetchAllowed(link = (globalThis.navigator as (Navigator & { connection?: Link }) | undefined)?.connection): boolean {
  if (!link) return true;
  if (link.saveData) return false;
  return !['slow-2g', '2g', '3g'].includes(link.effectiveType ?? '');
}

/**
 * What is worth fetching ahead: the tour only for a device that has not seen
 * it, the terminal and its drawer only for the owner, since a paired device cannot open one.
 */
export function prefetchNames<Name extends string>(names: Name[], device: { tourSeen: boolean; owner: boolean }): Name[] {
  return names.filter((name) => !(name === 'Onboarding' && device.tourSeen) && !((name === 'TerminalView' || name === 'TerminalDrawer') && !device.owner));
}

/**
 * The pages beside the chat and the terminal's code, fetched in the same idle
 * pass: Settings, the Agents page with its first snapshot when its experiment
 * is on, and xterm for the owner. A first visit then draws its content instead
 * of "loading"; App's own `import()` of each finds the module already there.
 */
export function warmPages(store: Store, agents: boolean): void {
  const quiet = () => undefined;
  void import('../components/SettingsShell.svelte').catch(quiet);
  if (agents) {
    void Promise.all([import('../components/agents/AgentsPage.svelte'), import('./agents.svelte')]).then(async ([, { AgentsView }]) => {
      const view = AgentsView.of(store);
      if (!view.snapshot && store.connection === 'ready') await view.refresh();
    }).catch(quiet);
  }
  if (store.owner) void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links')]).catch(quiet);
}
