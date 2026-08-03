<script lang="ts">
  import SquareArrowOutUpRight from "@lucide/svelte/icons/square-arrow-out-up-right";
  import X from "@lucide/svelte/icons/x";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * Detach and close, for a panel sitting in the docked column.
   *
   * These two belong to the column, not to the panel: a panel in a pane is
   * closed by its pane's own chrome, and one filling a mobile tab has nowhere to
   * be detached to. So SidePanel is the only caller, the panels take these as
   * optional props, and everywhere else they simply are not rendered.
   *
   * Living at the end of the panel's own header is the point. Drawn as a second
   * bar above it — which is what this replaces — the window carried two headers
   * for one panel, the top one naming a thing the icon below it already named.
   */
  type Props = { onDetach: () => void; onClose: () => void };
  let { onDetach, onClose }: Props = $props();
</script>

<!-- The hairline says these are not more of the panel's own actions: what is to
     its left acts on what the panel shows, what is to its right acts on the
     panel. -->
<span class="ml-1 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
<button
  type="button"
  class="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
  onclick={onDetach}
  title={t("panel.detach")}
  aria-label={t("panel.detach")}
>
  <SquareArrowOutUpRight class="size-3.5" />
</button>
<button
  type="button"
  class="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-[var(--color-surface-2)] hover:text-foreground"
  onclick={onClose}
  title={t("panel.close")}
  aria-label={t("panel.close")}
>
  <X class="size-3.5" />
</button>
