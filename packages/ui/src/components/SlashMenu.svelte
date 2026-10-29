<script lang="ts">
  import { AGENT_PREFIX, isAgentCommand, slashName } from '../lib/commands.svelte';
  import { SKILL_PREFIX } from '../lib/composer-menus';
  import type { PaletteItem } from '../lib/palette';
  import { strings } from '../lib/strings';
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
    const group = (row: PaletteItem): string => isAgentCommand(row) ? strings.slash.agent
      : row.id.startsWith(SKILL_PREFIX) ? strings.slash.skills : strings.slash.app;
    return previous && group(previous) === group(item) ? null : group(item);
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
