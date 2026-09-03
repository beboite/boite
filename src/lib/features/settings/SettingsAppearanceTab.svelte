<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import type { MessageKey } from "$lib/i18n/index.svelte";
  import { LOCALE_OPTIONS, t } from "$lib/i18n/index.svelte";
  import type {
    MotionMode,
    SmartSortBy,
    SortDirection,
    ThemeId,
    ThemeMode,
  } from "$lib/types";
  import { ACCENT_COLOR, type ModelAccent } from "$lib/features/fastpick/accent";
  import { THEMES } from "$lib/theme/themes";
  import {
    availableFonts,
    MONO_CANDIDATES,
    SANS_CANDIDATES,
    terminalFontSize,
    TERMINAL_SCALE_MAX,
    TERMINAL_SCALE_MIN,
  } from "$lib/theme/fonts";

  /**
   * "System" first, then the registry in its own order.
   *
   * `preview` is which palette the swatch paints itself in, and system has
   * none of its own: it is the two it can resolve to, drawn as one tile split
   * down the middle, which is the only honest picture of "whichever the OS
   * says".
   */
  const THEME_MODES: {
    id: ThemeMode;
    labelKey: MessageKey;
    preview: ThemeId | "split";
  }[] = [
    { id: "system", labelKey: "appearance.themeSystem", preview: "split" },
    ...THEMES.map((theme) => ({
      id: theme.id as ThemeMode,
      labelKey: theme.labelKey,
      preview: theme.id as ThemeId | "split",
    })),
  ];

  const anyAcrylic = $derived(
    THEMES.some((theme) => theme.acrylic && settings.state.themeMode === theme.id),
  );

  // Three, not two. The pin was a one-way door: one tap and the layout stopped
  // following the device for the life of the install, with nothing saying so.
  const LAYOUT_MODES: { id: "auto" | "mobile" | "pc"; labelKey: MessageKey }[] = [
    { id: "auto", labelKey: "appearance.layoutAuto" },
    { id: "mobile", labelKey: "appearance.mobile" },
    { id: "pc", labelKey: "appearance.pc" },
  ];

  /**
   * How the sidebar orders its threads.
   *
   * These two rows used to hang under an "smart ordering" experiment switch.
   * The ordering is no longer optional, so the switch is gone and the choice it
   * guarded moved here, beside the other things that decide what the window
   * looks like. `manual` is the dragged order and stays the default: the
   * feature is that you can pick, not that something reorders behind you.
   */
  const SORT_MODES: { id: SmartSortBy; labelKey: MessageKey }[] = [
    { id: "manual", labelKey: "appearance.sortManual" },
    { id: "activity", labelKey: "appearance.sortActivity" },
    { id: "alphabetical", labelKey: "appearance.sortAlpha" },
  ];

  const SORT_DIRECTIONS: { id: SortDirection; labelKey: MessageKey }[] = [
    { id: "asc", labelKey: "appearance.sortAsc" },
    { id: "desc", labelKey: "appearance.sortDescending" },
  ];

  const sortManual = $derived(settings.state.smartSortBy === "manual");

  const RADIO =
    "rounded-md border px-3 py-1 text-xs transition border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground";
  const RADIO_ON =
    "rounded-md border px-3 py-1 text-xs transition border-foreground/40 bg-[var(--color-surface-3)] text-foreground";

  const MOTION_MODES: { id: MotionMode; labelKey: MessageKey }[] = [
    { id: "system", labelKey: "appearance.motionSystem" },
    { id: "on", labelKey: "appearance.motionOn" },
    { id: "off", labelKey: "appearance.motionOff" },
  ];

  // `native` is left out: it is the absence of a tint, and a legend entry for "looks
  // exactly like it always has" explains nothing.
  const ACCENTS: { id: Exclude<ModelAccent, "native">; labelKey: MessageKey }[] = [
    { id: "claude", labelKey: "appearance.accentClaude" },
    { id: "gpt", labelKey: "appearance.accentGpt" },
    { id: "local", labelKey: "appearance.accentLocal" },
    { id: "other", labelKey: "appearance.accentOther" },
  ];

  function onSlider(e: Event) {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    settings.setUiScalePercent(value);
  }

  function reset() {
    settings.setUiScalePercent(100);
  }

  // Probed once, when the tab mounts: the probe measures a string per candidate
  // per generic, and the answer cannot change while the app is open without the
  // user installing a font behind it.
  const monoFonts = availableFonts(MONO_CANDIDATES);
  const sansFonts = availableFonts(SANS_CANDIDATES);

  // A family stored on a machine that does not have it is deliberately kept by
  // the store, so the select has to be able to show a name that is not in the
  // list. Without an option carrying it, the box falls back to "Default" and
  // reports no choice while the family is still stored and still in front of
  // the stack. Disabled, because it is a state to see, not one to pick.
  const missingSans = $derived(
    settings.state.uiFontFamily && !sansFonts.includes(settings.state.uiFontFamily)
      ? settings.state.uiFontFamily
      : null,
  );
  const missingMono = $derived(
    settings.state.terminalFontFamily &&
      !monoFonts.includes(settings.state.terminalFontFamily)
      ? settings.state.terminalFontFamily
      : null,
  );

  // The same call the terminals make, so the sample is the size they will be
  // rather than the size they would be at 100% zoom. Pinch is left at 1: it is
  // per-pane and transient, and no pane is on screen to read it from.
  const sampleSize = $derived(
    terminalFontSize(
      settings.state.uiScalePercent,
      settings.state.terminalFontScalePercent,
    ),
  );

  function onTerminalScale(e: Event) {
    settings.setTerminalFontScalePercent(
      Number((e.currentTarget as HTMLInputElement).value),
    );
  }
</script>

{#snippet preview(theme: ThemeId)}
  <!-- The swatch carries the theme's own attribute, so every colour in here is
       the palette itself rather than a copy of it kept in this component and
       drifting from app.css one commit at a time. -->
  <span class="swatch-window" data-theme={theme}>
    <span class="swatch-titlebar"></span>
    <span class="swatch-body">
      <span class="swatch-sidebar"></span>
      <span class="swatch-main">
        <span class="swatch-line"></span>
        <span class="swatch-line short"></span>
      </span>
    </span>
  </span>
{/snippet}

<SettingsCard
  title={t("appearance.theme")}
  anchor="appearance.theme"
  description={t("appearance.themeDesc")}
>
  <div class="theme-grid" role="radiogroup" aria-label={t("appearance.theme")}>
    {#each THEME_MODES as mode (mode.id)}
      <button
        type="button"
        role="radio"
        aria-checked={settings.state.themeMode === mode.id}
        class="theme-swatch {settings.state.themeMode === mode.id ? 'selected' : ''}"
        onclick={() => settings.setThemeMode(mode.id)}
      >
        <!-- The desk is what an acrylic palette is see-through onto. Opaque
             themes cover it whole, which is the difference the swatch exists to
             show. -->
        <span class="swatch-desk">
          {#if mode.preview === "split"}
            <span class="swatch-half">{@render preview("dark")}</span>
            <span class="swatch-half right">{@render preview("light")}</span>
          {:else}
            {@render preview(mode.preview)}
          {/if}
        </span>
        <span class="swatch-label">{t(mode.labelKey)}</span>
      </button>
    {/each}
  </div>

  {#if anyAcrylic}
    <p class="mt-2 text-2xs leading-relaxed text-muted-foreground">
      {t("appearance.themeAcrylicNote")}
    </p>
  {/if}
</SettingsCard>

<SettingsCard
  title={t("appearance.uiScale")}
  anchor="appearance.uiScale"
  description={t("appearance.uiScaleDesc")}
>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={reset}
      use:tip={t("appearance.resetScale")}
    >
      <RotateCcw class="size-3" />
      {t("common.reset")}
    </button>
  {/snippet}

  <div class="flex items-center gap-3">
    <span class="w-9 tabular-nums text-2xs text-muted-foreground/70">75%</span>
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
    <span class="w-12 text-right tabular-nums text-xs font-semibold text-foreground">
      {settings.state.uiScalePercent}%
    </span>
  </div>
</SettingsCard>

<SettingsCard
  title={t("appearance.fonts")}
  anchor="appearance.fonts"
  description={t("appearance.fontsDesc")}
>
  <div class="flex flex-col gap-2.5">
    <label class="flex items-center gap-3 text-xs text-muted-foreground">
      <span class="w-24 shrink-0">{t("appearance.fontUi")}</span>
      <select
        class="font-select min-w-0 flex-1"
        value={settings.state.uiFontFamily ?? ""}
        onchange={(e) => settings.setUiFontFamily(e.currentTarget.value || null)}
      >
        <option value="">{t("appearance.fontDefault")}</option>
        {#if missingSans}
          <option value={missingSans} disabled>{missingSans} ({t("appearance.fontMissing")})</option>
        {/if}
        {#each sansFonts as family (family)}
          <option value={family}>{family}</option>
        {/each}
      </select>
    </label>

    <label class="flex items-center gap-3 text-xs text-muted-foreground">
      <span class="w-24 shrink-0">{t("appearance.fontTerminal")}</span>
      <select
        class="font-select min-w-0 flex-1"
        value={settings.state.terminalFontFamily ?? ""}
        onchange={(e) =>
          settings.setTerminalFontFamily(e.currentTarget.value || null)}
      >
        <option value="">{t("appearance.fontDefault")}</option>
        {#if missingMono}
          <option value={missingMono} disabled>{missingMono} ({t("appearance.fontMissing")})</option>
        {/if}
        {#each monoFonts as family (family)}
          <option value={family}>{family}</option>
        {/each}
      </select>
    </label>

    <!-- The sample is set in whatever the terminal is set in, at the size the
         terminal will be: a font list whose entries are all drawn in the UI
         font tells you nothing about the one thing you are picking it for. -->
    <p
      class="truncate rounded-md border border-border bg-[var(--color-background)] px-2.5 py-1.5 text-term-foreground"
      style:font-family="var(--font-mono)"
      style:font-size="{sampleSize}px"
    >
      {t("appearance.fontSample")}
    </p>
  </div>
</SettingsCard>

<SettingsCard
  title={t("appearance.terminalSize")}
  anchor="appearance.terminalSize"
  description={t("appearance.terminalSizeDesc")}
>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={() => settings.setTerminalFontScalePercent(100)}
      use:tip={t("appearance.resetTerminalSize")}
    >
      <RotateCcw class="size-3" />
      {t("common.reset")}
    </button>
  {/snippet}

  <div class="flex items-center gap-3">
    <span class="w-9 tabular-nums text-2xs text-muted-foreground/70">
      {TERMINAL_SCALE_MIN}%
    </span>
    <input
      type="range"
      min={TERMINAL_SCALE_MIN}
      max={TERMINAL_SCALE_MAX}
      step="5"
      value={settings.state.terminalFontScalePercent}
      oninput={onTerminalScale}
      class="ui-slider min-w-0 flex-1"
      aria-label={t("appearance.terminalSize")}
    />
    <span class="w-12 text-right tabular-nums text-xs font-semibold text-foreground">
      {settings.state.terminalFontScalePercent}%
    </span>
  </div>
</SettingsCard>

<SettingsCard
  title={t("appearance.layout")}
  anchor="appearance.layout"
  description={t("appearance.layoutDesc")}
>
  <div class="flex gap-1.5" role="radiogroup" aria-label={t("appearance.layout")}>
    {#each LAYOUT_MODES as mode (mode.id)}
      {@const on =
        mode.id === "auto"
          ? !settings.state.layoutPinned
          : settings.state.layoutPinned &&
            settings.state.mobileLayout === (mode.id === "mobile")}
      <button
        type="button"
        role="radio"
        aria-checked={on}
        class="rounded-md border px-3 py-1 text-xs transition
          {on
            ? 'border-foreground/40 bg-[var(--color-surface-3)] text-foreground'
            : 'border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground'}"
        onclick={() => {
          if (mode.id === "auto") settings.unpinLayout();
          else settings.setMobileLayout(mode.id === "mobile");
        }}
      >
        {t(mode.labelKey)}
      </button>
    {/each}
  </div>
</SettingsCard>

<SettingsCard
  title={t("appearance.sort")}
  anchor="appearance.sort"
  description={t("appearance.sortDesc")}
>
  <div class="flex flex-col gap-2">
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label={t("appearance.sort")}
    >
      <span class="w-20 shrink-0 text-xs text-muted-foreground">
        {t("appearance.sortOrder")}
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
    <!-- Disabled rather than hidden while the order is manual: a row that
         vanishes reads as lost. -->
    <div
      class="flex flex-wrap items-center gap-1.5"
      class:opacity-50={sortManual}
      role="radiogroup"
      aria-label={t("appearance.sortDirection")}
      use:tip={sortManual ? t("appearance.sortDirManual") : undefined}
    >
      <span class="w-20 shrink-0 text-xs text-muted-foreground">
        {t("appearance.sortDirection")}
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
</SettingsCard>

<ToggleSetting
  label={t("appearance.colorByModel")} anchor="appearance.colorByModel"
  description={t("appearance.colorByModelDesc")}
  enabled={settings.state.colorByModel}
  onToggle={() => settings.setColorByModel(!settings.state.colorByModel)}
/>

{#if settings.state.colorByModel}
  <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 pb-1">
    {#each ACCENTS as accent (accent.id)}
      <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          class="size-2 shrink-0 rounded-full"
          style:background-color={ACCENT_COLOR[accent.id]}
        ></span>
        {t(accent.labelKey)}
      </span>
    {/each}
  </div>
{/if}

<SettingsCard title={t("appearance.animations")} anchor="appearance.animations" description={t("appearance.animationsDesc")}>
  <div class="flex gap-1.5" role="radiogroup" aria-label={t("appearance.animations")}>
    {#each MOTION_MODES as mode (mode.id)}
      <button
        type="button"
        role="radio"
        aria-checked={settings.state.motionMode === mode.id}
        class="rounded-md border px-3 py-1 text-xs transition
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

<SettingsCard title={t("appearance.language")} anchor="appearance.language" description={t("appearance.languageDesc")}>
  <div class="flex gap-1.5" role="radiogroup" aria-label={t("appearance.language")}>
    {#each LOCALE_OPTIONS as option (option.id)}
      <button
        type="button"
        role="radio"
        aria-checked={settings.state.locale === option.id}
        class="rounded-md border px-3 py-1 text-xs transition
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
  .font-select {
    appearance: none;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    color: var(--color-foreground);
    padding: 3px 8px;
    font-size: var(--text-xs);
    font-family: inherit;
  }
  .font-select:hover {
    border-color: color-mix(in srgb, var(--color-foreground) 30%, transparent);
  }
  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 8px;
  }

  .theme-swatch {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 4px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-2);
    text-align: left;
    transition:
      border-color var(--dur-2) var(--ease-out-quint),
      background-color var(--dur-2) var(--ease-out-quint);
  }
  .theme-swatch:hover {
    border-color: color-mix(in srgb, var(--color-foreground) 30%, transparent);
  }
  .theme-swatch.selected {
    border-color: color-mix(in srgb, var(--color-foreground) 45%, transparent);
    background: var(--color-surface-3);
  }

  /* Stands in for the desktop, and it is the only fabricated colour in the
     swatch. A wallpaper is whatever the user has, so this is a neutral gradient
     with enough contrast across it that a translucent window reads as
     translucent and not as a slightly-off flat tone. */
  .swatch-desk {
    position: relative;
    display: flex;
    overflow: hidden;
    aspect-ratio: 16 / 10;
    border-radius: var(--radius-xs);
    background: linear-gradient(135deg, #6d7fa3 0%, #47506b 45%, #8a7f96 100%);
  }

  .swatch-half {
    display: flex;
    width: 50%;
    overflow: hidden;
  }
  .swatch-half :global(.swatch-window) {
    width: 200%;
  }
  .swatch-half.right :global(.swatch-window) {
    margin-left: -100%;
  }

  .swatch-window {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    background: var(--color-background);
  }
  .swatch-titlebar {
    height: 22%;
    background: var(--color-titlebar);
  }
  .swatch-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .swatch-sidebar {
    width: 32%;
    background: var(--color-surface);
  }
  .swatch-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    gap: 3px;
    padding: 0 5px;
  }
  .swatch-line {
    height: 2px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-foreground) 55%, transparent);
  }
  .swatch-line.short {
    width: 55%;
    background: color-mix(in srgb, var(--color-foreground) 28%, transparent);
  }

  .swatch-label {
    padding: 0 2px 1px;
    font-size: var(--text-2xs);
    color: var(--color-muted-foreground);
  }
  .theme-swatch.selected .swatch-label {
    color: var(--color-foreground);
  }

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
