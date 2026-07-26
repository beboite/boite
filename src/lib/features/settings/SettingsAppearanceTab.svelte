<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import type { MessageKey } from "$lib/i18n/index.svelte";
  import { LOCALE_OPTIONS, t } from "$lib/i18n/index.svelte";
  import type { MotionMode } from "$lib/types";

  const MOTION_MODES: { id: MotionMode; labelKey: MessageKey }[] = [
    { id: "system", labelKey: "appearance.motionSystem" },
    { id: "on", labelKey: "appearance.motionOn" },
    { id: "off", labelKey: "appearance.motionOff" },
  ];

  function onSlider(e: Event) {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    settings.setUiScalePercent(value);
  }

  function reset() {
    settings.setUiScalePercent(100);
  }
</script>

<SettingsCard title={t("appearance.uiScale")} description={t("appearance.uiScaleDesc")}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={reset}
      title={t("appearance.resetScale")}
    >
      <RotateCcw class="size-3" />
      {t("common.reset")}
    </button>
  {/snippet}

  <div class="flex items-center gap-3">
    <span class="w-9 font-mono text-[10px] text-muted-foreground/70">75%</span>
    <input
      type="range"
      min="75"
      max="150"
      step="5"
      value={settings.state.uiScalePercent}
      oninput={onSlider}
      class="ui-slider min-w-0 flex-1"
      aria-label={t("appearance.uiScale")}
    />
    <span class="w-12 text-right font-mono text-xs font-semibold text-foreground">
      {settings.state.uiScalePercent}%
    </span>
  </div>
</SettingsCard>

<ToggleSetting
  label={t("appearance.layout")}
  description={t("appearance.layoutDesc")}
  enabled={settings.state.mobileLayout}
  onLabel={t("appearance.mobile")}
  offLabel={t("appearance.pc")}
  onToggle={() => settings.setMobileLayout(!settings.state.mobileLayout)}
/>

<SettingsCard title={t("appearance.animations")} description={t("appearance.animationsDesc")}>
  <div class="flex gap-1.5" role="radiogroup" aria-label={t("appearance.animations")}>
    {#each MOTION_MODES as mode (mode.id)}
      <button
        type="button"
        role="radio"
        aria-checked={settings.state.motionMode === mode.id}
        class="rounded-md border px-3 py-1 text-[11px] transition
          {settings.state.motionMode === mode.id
            ? 'border-foreground/40 bg-[var(--color-surface-3)] text-foreground'
            : 'border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground'}"
        onclick={() => settings.setMotionMode(mode.id)}
      >
        {t(mode.labelKey)}
      </button>
    {/each}
  </div>
</SettingsCard>

<SettingsCard title={t("appearance.language")} description={t("appearance.languageDesc")}>
  <div class="flex gap-1.5" role="radiogroup" aria-label={t("appearance.language")}>
    {#each LOCALE_OPTIONS as option (option.id)}
      <button
        type="button"
        role="radio"
        aria-checked={settings.state.locale === option.id}
        class="rounded-md border px-3 py-1 text-[11px] transition
          {settings.state.locale === option.id
            ? 'border-foreground/40 bg-[var(--color-surface-3)] text-foreground'
            : 'border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground'}"
        onclick={() => settings.setLocale(option.id)}
      >
        {t(option.labelKey)}
      </button>
    {/each}
  </div>
</SettingsCard>

<style>
  .ui-slider {
    appearance: none;
    background: transparent;
    height: 16px;
  }
  .ui-slider::-webkit-slider-runnable-track {
    height: 3px;
    background: var(--color-border);
    border-radius: 999px;
  }
  .ui-slider::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4.5px;
    border-radius: 50%;
    background: var(--color-foreground);
    cursor: pointer;
    border: 2px solid var(--color-surface);
    transition: transform 100ms;
  }
  .ui-slider::-webkit-slider-thumb:hover {
    transform: scale(1.15);
  }
  .ui-slider::-moz-range-track {
    height: 3px;
    background: var(--color-border);
    border-radius: 999px;
  }
  .ui-slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--color-foreground);
    cursor: pointer;
    border: 2px solid var(--color-surface);
  }
</style>
