<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import type { MotionMode } from "$lib/types";

  const MOTION_MODES: { id: MotionMode; label: string }[] = [
    { id: "system", label: "System" },
    { id: "on", label: "On" },
    { id: "off", label: "Off" },
  ];

  function onSlider(e: Event) {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    settings.setUiScalePercent(value);
  }

  function reset() {
    settings.setUiScalePercent(100);
  }
</script>

<SettingsCard
  title="UI scale"
  description="Drag, or use Ctrl + scroll wheel / Ctrl + + / Ctrl + − / Ctrl + 0."
>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={reset}
      title="Reset to 100%"
    >
      <RotateCcw class="size-3" />
      Reset
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
      aria-label="UI scale"
    />
    <span class="w-12 text-right font-mono text-xs font-semibold text-foreground">
      {settings.state.uiScalePercent}%
    </span>
  </div>
</SettingsCard>

<ToggleSetting
  label="Layout"
  description="Mobile stacks everything into full-width pages with a bottom bar and bigger touch targets. PC keeps the sidebar and side panels."
  enabled={settings.state.mobileLayout}
  onLabel="Mobile"
  offLabel="PC"
  onToggle={() => settings.setMobileLayout(!settings.state.mobileLayout)}
/>

<SettingsCard
  title="Animations"
  description="System follows the OS reduced-motion setting; On and Off override it."
>
  <div class="flex gap-1.5" role="radiogroup" aria-label="Animations">
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
        {mode.label}
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
