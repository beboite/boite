<script lang="ts">
  import { AGENT_PREFIX, isAgentCommand, slashName } from '../lib/commands.svelte';
  import type { PaletteItem } from '../lib/palette';
  import { strings } from '../lib/i18n.svelte';
  import ComposerMenu from './ComposerMenu.svelte';

  /**
   * What `/` opens over the composer: the agent's own commands first, Boite's
   * under them, on the shared composer menu.
   */
  let {
    open,
    items,
    selected,
    onpick,
    onhover
  }: {
    open: boolean;
    items: PaletteItem[];
    /** The row the keyboard is on, an index into `items`. */
    selected: number;
    onpick: (item: PaletteItem) => void;
    onhover: (index: number) => void;
  } = $props();

  /** The heading before a row: only where the group changes, like the palette. */
  function heading(index: number): string | null {
    const item = items[index];
    if (!item) return null;
    const previous = items[index - 1];
    if (previous && isAgentCommand(previous) === isAgentCommand(item)) return null;
    return isAgentCommand(item) ? strings.slash.agent : strings.slash.app;
  }

  function nameOf(item: PaletteItem): string {
    return isAgentCommand(item) ? item.id.slice(AGENT_PREFIX.length) : slashName(item);
  }
</script>

<ComposerMenu
  {open}
  {items}
  {selected}
  kind="slash"
  label={strings.slash.label}
  empty={strings.slash.empty}
  {heading}
  {nameOf}
  {onpick}
  {onhover}
/>
