<script lang="ts">
  import ThreadGlyph from "$lib/features/thread/ThreadGlyph.svelte";
  import { visibleStatus } from "$lib/domain/thread-status";
  import { threadIconColor } from "$lib/features/fastpick/threadAccent";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { Thread } from "$lib/types";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";

  type Props = {
    stack: Thread[];
    count: number;
    expanded: boolean;
    onToggle: () => void;
  };
  let { stack, count, expanded, onToggle }: Props = $props();

  const shown = $derived(stack.slice(0, 3));
  const glow = $derived(settings.state.sidebarDesign === "glow");
  const label = $derived(
    expanded
      ? t("sidebar.collapseDelegations")
      : count === 1
        ? t("sidebar.delegationStackOne")
        : t("sidebar.delegationStack", { count }),
  );
</script>

<button
  type="button"
  data-no-drag
  class="pile relative flex shrink-0 items-center"
  class:open={expanded}
  aria-expanded={expanded}
  aria-label={label}
  title={label}
  onclick={(e) => {
    e.stopPropagation();
    onToggle();
  }}
>
  {#if expanded}
    <ChevronRight class="size-3 rotate-90 text-muted-foreground" />
  {:else}
    <span class="faces" aria-hidden="true">
      {#each shown as child, i (child.id)}
        <span class="face" style:z-index={i + 1}>
          <ThreadGlyph
            status={visibleStatus(child.status, !!child.ptyId)}
            iconKey={child.iconKey}
            color={threadIconColor(child)}
            asleep={child.autoSlept ?? false}
            keepAwake={(child.keepAwake ?? false) && !!child.ptyId}
            design={settings.state.sidebarDesign}
            showLogo={true}
            size={16}
            inert
          />
        </span>
      {/each}
    </span>
    <span
      class="relative ml-1 text-2xs font-medium tabular-nums leading-none {glow
        ? 'text-foreground/80'
        : 'text-muted-foreground'}"
    >
      {count}
    </span>
  {/if}
</button>

<style>
  .pile {
    height: 20px;
    padding: 0 3px 0 2px;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .pile:hover {
    background: color-mix(in srgb, var(--color-foreground) 8%, transparent);
  }
  .faces {
    display: flex;
    align-items: center;
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
