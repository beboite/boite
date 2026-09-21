<script lang="ts">
  import type { PaletteItem } from '../lib/palette';
  import { fill, strings } from '../lib/strings';
  import ComposerMenu from './ComposerMenu.svelte';

  /**
   * What `@` opens over the composer: the project's files the core ranked on
   * the word after the at sign. A row is the file's name with its directory
   * under it, and its id is the path the pick writes in. When the core held
   * more matches than the page, the last line says how many.
   */
  let {
    open,
    items,
    selected,
    more,
    onpick,
    onhover
  }: {
    open: boolean;
    items: PaletteItem[];
    /** The row the keyboard is on, an index into `items`. */
    selected: number;
    /** Matches beyond the page, 0 when it holds them all. */
    more: number;
    onpick: (item: PaletteItem) => void;
    onhover: (index: number) => void;
  } = $props();

  let footer = $derived(more > 0 ? fill(strings.mention.more, { count: String(more) }) : null);
</script>

<ComposerMenu
  {open}
  {items}
  {selected}
  kind="mention"
  label={strings.mention.label}
  empty={strings.mention.empty}
  {footer}
  nameOf={(item) => item.id}
  {onpick}
  {onhover}
/>
