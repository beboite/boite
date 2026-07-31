<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";

  type Props = {
    label: string;
    description?: string;
    enabled: boolean;
    onLabel?: string;
    offLabel?: string;
    onToggle: () => void;
  };
  let {
    label,
    description = "",
    enabled,
    onLabel = t("common.on"),
    offLabel = t("common.off"),
    onToggle,
  }: Props = $props();
</script>

<!-- role=switch, so the state is announced. It used to be a plain button whose
     only account of being on was the word beside it and the pill's fill. -->
<button
  type="button"
  role="switch"
  aria-checked={enabled}
  class="group flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-[var(--color-surface)] px-3 py-2.5 text-left transition hover:border-foreground/25"
  onclick={onToggle}
>
  <div class="min-w-0 flex-1">
    <div class="text-xs font-medium text-foreground">{label}</div>
    {#if description}
      <div class="mt-0.5 text-xs leading-snug text-muted-foreground">
        {description}
      </div>
    {/if}
  </div>
  <div class="flex shrink-0 items-center gap-2.5">
    <span class="text-2xs font-medium uppercase tracking-wider {enabled ? 'text-foreground' : 'text-muted-foreground/70'}">
      {enabled ? onLabel : offLabel}
    </span>
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
