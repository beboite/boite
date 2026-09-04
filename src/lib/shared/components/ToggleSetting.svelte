<script lang="ts">
  import { settingAnchorId } from "$lib/features/settings/catalogue";

  type Props = {
    label: string;
    description?: string;
    /**
     * A word beside the label, in the app's own tag shape (`DashboardCard`).
     * For a row that is new rather than for one that carries a count, so it is
     * a caller's string: the dictionary key belongs where the row is declared.
     */
    badge?: string;
    /** See SettingsCard: the key this is labelled with, for settings search. */
    anchor?: string;
    enabled: boolean;
    onToggle: () => void;
  };
  let {
    label,
    description = "",
    badge = "",
    anchor,
    enabled,
    onToggle,
  }: Props = $props();
</script>

<!-- role=switch, so the state is announced. It used to be a plain button whose
     only account of being on was the word beside it and the pill's fill. -->
<button
  type="button"
  role="switch"
  id={anchor ? settingAnchorId(anchor) : undefined}
  aria-checked={enabled}
  aria-label={label}
  class="group scroll-mt-4 flex w-full items-center justify-between gap-3 rounded-lg border border-edge bg-[var(--color-surface)] px-3 py-2.5 text-left transition hover:border-foreground/25"
  onclick={onToggle}
>
  <div class="min-w-0 flex-1">
    <div class="flex items-center gap-1.5">
      <span class="text-sm font-medium text-foreground">{label}</span>
      {#if badge}
        <span
          class="shrink-0 rounded-full bg-[var(--color-surface-2)] px-1.5 py-px text-xs font-medium text-muted-foreground"
        >
          {badge}
        </span>
      {/if}
    </div>
    {#if description}
      <div class="mt-0.5 text-sm text-muted-foreground">
        {description}
      </div>
    {/if}
  </div>
  <div class="flex shrink-0 items-center">
    <span
      class="relative h-4 w-7 rounded-full transition-colors {enabled
        ? 'bg-foreground'
        : 'bg-[var(--color-surface-3)]'}"
    >
      <span
        class="absolute left-0.5 top-0.5 size-3 rounded-full bg-background shadow-sm transition-transform {enabled
          ? 'translate-x-3'
          : 'translate-x-0'}"
      ></span>
    </span>
  </div>
</button>
