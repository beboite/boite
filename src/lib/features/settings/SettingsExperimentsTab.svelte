<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import type { SmartSortBy, SortDirection } from "$lib/types";

  const SORT_MODES: { id: SmartSortBy; labelKey: MessageKey }[] = [
    { id: "manual", labelKey: "experiments.smartSortManual" },
    { id: "activity", labelKey: "experiments.smartSortActivity" },
    { id: "alphabetical", labelKey: "experiments.smartSortAlpha" },
  ];

  const SORT_DIRECTIONS: { id: SortDirection; labelKey: MessageKey }[] = [
    { id: "asc", labelKey: "experiments.smartSortAsc" },
    { id: "desc", labelKey: "experiments.smartSortDescending" },
  ];

  const RADIO =
    "rounded-md border px-3 py-1 text-xs transition border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground";
  const RADIO_ON =
    "rounded-md border px-3 py-1 text-xs transition border-foreground/40 bg-[var(--color-surface-3)] text-foreground";

  const sortManual = $derived(settings.state.smartSortBy === "manual");
</script>

<p class="px-3 text-sm text-muted-foreground">{t("experiments.intro")}</p>

<ToggleSetting
  label={t("experiments.infoBox")} anchor="experiments.infoBox"
  description={t("experiments.infoBoxDesc")}
  enabled={settings.state.experimentInfoBox}
  onToggle={() => settings.setExperimentInfoBox(!settings.state.experimentInfoBox)}
/>

<ToggleSetting
  label={t("experiments.smartSort")} anchor="experiments.smartSort"
  description={t("experiments.smartSortDesc")}
  enabled={settings.state.experimentSmartSort}
  onToggle={() =>
    settings.setExperimentSmartSort(!settings.state.experimentSmartSort)}
/>

{#if settings.state.experimentSmartSort}
  <div class="flex flex-col gap-2 pl-3">
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label={t("experiments.smartSortOrder")}
    >
      <span class="w-20 shrink-0 text-xs text-muted-foreground">
        {t("experiments.smartSortOrder")}
      </span>
      {#each SORT_MODES as mode (mode.id)}
        <button
          type="button"
          role="radio"
          aria-checked={settings.state.smartSortBy === mode.id}
          class={settings.state.smartSortBy === mode.id ? RADIO_ON : RADIO}
          onclick={() => settings.setSmartSortBy(mode.id)}
        >
          {t(mode.labelKey)}
        </button>
      {/each}
    </div>
    <!-- Disabled rather than hidden while the order is manual, like the logo
         row under the design toggle: a row that vanishes reads as lost. -->
    <div
      class="flex flex-wrap items-center gap-1.5"
      class:opacity-50={sortManual}
      role="radiogroup"
      aria-label={t("experiments.smartSortDirection")}
      title={sortManual ? t("experiments.smartSortDirManual") : undefined}
    >
      <span class="w-20 shrink-0 text-xs text-muted-foreground">
        {t("experiments.smartSortDirection")}
      </span>
      {#each SORT_DIRECTIONS as direction (direction.id)}
        <button
          type="button"
          role="radio"
          aria-checked={settings.state.smartSortDirection === direction.id}
          aria-disabled={sortManual}
          class={settings.state.smartSortDirection === direction.id ? RADIO_ON : RADIO}
          onclick={() => {
            if (sortManual) return;
            settings.setSmartSortDirection(direction.id);
          }}
        >
          {t(direction.labelKey)}
        </button>
      {/each}
    </div>
  </div>
{/if}

<ToggleSetting
  label={t("experiments.sidebarDesign")} anchor="experiments.sidebarDesign"
  description={t("experiments.sidebarDesignDesc")}
  enabled={settings.state.sidebarDesign === "glow"}
  onLabel={t("experiments.designGlow")}
  offLabel={t("experiments.designClassic")}
  onToggle={() =>
    settings.setSidebarDesign(
      settings.state.sidebarDesign === "glow" ? "classic" : "glow",
    )}
/>

<!-- Rendered in both designs, and disabled rather than hidden under the classic
     one. A row that vanishes with the setting above it reads as a setting that
     was lost, and the classic ring has nothing to put in the logo's place. -->
<div class="pl-3" class:opacity-50={settings.state.sidebarDesign !== "glow"}>
  <ToggleSetting
    label={t("experiments.harnessLogos")} anchor="experiments.harnessLogos"
    description={settings.state.sidebarDesign === "glow"
      ? t("experiments.harnessLogosDesc")
      : t("experiments.harnessLogosClassic")}
    enabled={settings.state.sidebarDesign !== "glow" ||
      settings.state.sidebarHarnessLogos}
    onToggle={() => {
      if (settings.state.sidebarDesign !== "glow") return;
      settings.setSidebarHarnessLogos(!settings.state.sidebarHarnessLogos);
    }}
  />
</div>
