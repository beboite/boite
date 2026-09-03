<script lang="ts">
  import ThreadGlyph from "$lib/features/thread/ThreadGlyph.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { t } from "$lib/i18n/index.svelte";
  import type { Thread } from "$lib/types";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CornerDownRight from "@lucide/svelte/icons/corner-down-right";

  type Props = {
    stack: Thread[];
    count: number;
    expanded: boolean;
    onToggle: () => void;
  };
  let { stack, count, expanded, onToggle }: Props = $props();

  const shown = $derived(stack.slice(0, 3));
  const label = $derived(
    expanded
      ? t("sidebar.collapseDelegations")
      : count === 1
        ? t("sidebar.delegationStackOne")
        : t("sidebar.delegationStack", { count }),
  );
</script>

<!-- The children's own row, under the parent and indented like them, rather
     than a pile of faces crammed into the parent's card. A thread row is the
     unit this sidebar reads in, so the thing standing in for threads takes one
     too: same height, same padding, same rounding. -->
<button
  type="button"
  data-no-drag
  class="pile flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-1 text-left transition"
  class:open={expanded}
  aria-expanded={expanded}
  aria-label={label}
  use:tip={label}
  onclick={(e) => {
    e.stopPropagation();
    onToggle();
  }}
>
  <CornerDownRight class="size-3 shrink-0 text-muted-foreground/60" />
  {#if !expanded && shown.length > 0}
    <span class="faces" aria-hidden="true">
      {#each shown as child, i (child.id)}
        <span class="face" style:z-index={i + 1}>
          <ThreadGlyph
            status={visibleStatus(child.status, !!child.ptyId)}
            iconKey={child.iconKey}
            color={threadIconColor(child)}
            keepAwake={(child.keepAwake ?? false) && !!child.ptyId}
            size={16}
            inert
          />
        </span>
      {/each}
    </span>
  {/if}
  <span
    class="min-w-0 flex-1 truncate-safe text-2xs font-medium leading-[19px] text-foreground/80"
  >
    {label}
  </span>
  <ChevronRight
    class="size-3 shrink-0 text-muted-foreground/70 transition-transform {expanded
      ? 'rotate-90'
      : ''}"
  />
</button>

<style>
  /* Outlined rather than filled, like the thread cards above it: the pile is
     one of the rows, not a block sitting between them. */
  .pile {
    border: 0;
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--color-border);
    color: inherit;
  }
  .pile:hover {
    background: color-mix(in srgb, var(--color-foreground) 6%, transparent);
  }
  .faces {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .face {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: -7px;
    border-radius: 9999px;
    background: var(--color-surface-2);
    box-shadow: 0 0 0 1px var(--color-border);
  }
  .face:first-child {
    margin-left: 0;
  }
</style>
