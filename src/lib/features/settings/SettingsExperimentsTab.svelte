<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import VoiceSettings from "$lib/features/voice/VoiceSettings.svelte";
  import type { SmartSortBy, SortDirection, WhipSound } from "$lib/types";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";

  const SORT_MODES: { id: SmartSortBy; labelKey: MessageKey }[] = [
    { id: "manual", labelKey: "experiments.smartSortManual" },
    { id: "activity", labelKey: "experiments.smartSortActivity" },
    { id: "alphabetical", labelKey: "experiments.smartSortAlpha" },
  ];

  const SORT_DIRECTIONS: { id: SortDirection; labelKey: MessageKey }[] = [
    { id: "asc", labelKey: "experiments.smartSortAsc" },
    { id: "desc", labelKey: "experiments.smartSortDescending" },
  ];

  const WHIP_SOUNDS: { id: WhipSound; labelKey: MessageKey }[] = [
    { id: "synth", labelKey: "experiments.whipSoundSynth" },
    { id: "sampled", labelKey: "experiments.whipSoundMeme" },
  ];

  const RADIO =
    "rounded-md border px-3 py-1 text-xs transition border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground";
  const RADIO_ON =
    "rounded-md border px-3 py-1 text-xs transition border-foreground/40 bg-[var(--color-surface-3)] text-foreground";

  const sortManual = $derived(settings.state.smartSortBy === "manual");

  function whipSoundOn(id: WhipSound): boolean {
    if (id === "sampled") {
      return settings.state.whipSound === "sampled" || settings.state.whipSound === "meme";
    }
    return settings.state.whipSound === id;
  }

  /**
   * Cracks once so the choice is audible.
   *
   * The module is imported here rather than at the top so the settings chunk
   * does not carry the whip's audio for the pages that never open this row, and
   * the sample is awaited: previewing `meme` and hearing the synth because the
   * fetch had not landed is the one thing this button must not do.
   */
  /**
   * Turning the experiment off unmounts the surface, and asks once whether the
   * live orchestrator threads should be put away with it. Their workers are
   * not touched either way: a spawned terminal belongs to the workspace, not
   * to the conductor that opened it, and "put away" is the sidebar's own
   * settle, reversible from there.
   */
  async function toggleOrchestrator() {
    const next = !settings.state.experimentOrchestrator;
    settings.setExperimentOrchestrator(next);
    if (next) return;
    const live = app.threads.filter(
      (thread) => thread.role === "orchestrator" && !thread.settledAt,
    );
    if (live.length === 0) return;
    const close = await confirmDialog.ask({
      title: t("experiments.orchestratorCloseTitle"),
      message: t("experiments.orchestratorCloseAsk", { count: live.length }),
      confirmLabel: t("experiments.orchestratorCloseConfirm"),
    });
    if (!close) return;
    for (const thread of live) {
      await app.settleThread(thread.id, true);
    }
  }

  async function playPreview(sound: WhipSound) {
    const { playCrack, primeCrackSound } = await import("$lib/features/whip/crack");
    await primeCrackSound(sound);
    playCrack(sound);
  }
</script>

<p class="px-3 text-sm text-muted-foreground">{t("experiments.intro")}</p>

<ToggleSetting
  label={t("experiments.home")} anchor="experiments.home"
  description={t("experiments.homeDesc")}
  enabled={settings.state.experimentHome}
  onToggle={() => settings.setExperimentHome(!settings.state.experimentHome)}
/>

<ToggleSetting
  label={t("experiments.orchestrator")} anchor="experiments.orchestrator"
  description={t("experiments.orchestratorDesc")}
  enabled={settings.state.experimentOrchestrator}
  onToggle={() => void toggleOrchestrator()}
/>

{#if settings.state.experimentOrchestrator}
  <div class="flex flex-col gap-1.5 pl-3">
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label={t("experiments.orchestratorAgent")}
    >
      <span class="w-20 shrink-0 text-xs text-muted-foreground">
        {t("experiments.orchestratorAgent")}
      </span>
      {#each CLI_PRESETS as preset (preset.id)}
        <button
          type="button"
          role="radio"
          aria-checked={settings.state.orchestratorAgent === preset.id}
          class={settings.state.orchestratorAgent === preset.id ? RADIO_ON : RADIO}
          onclick={() =>
            settings.setOrchestratorAgent(
              settings.state.orchestratorAgent === preset.id ? null : preset.id,
            )}
        >
          {preset.label}
        </button>
      {/each}
    </div>
    <!-- A shortcut can also name the agent, and a shortcut may point at a
         brokered endpoint; the warning follows the value, not the buttons. -->
    {#if settings.state.orchestratorAgent?.startsWith("fastpick:")}
      <p class="text-xs text-amber-500">{t("experiments.orchestratorBrokered")}</p>
    {/if}
    <ToggleSetting
      label={t("experiments.orchestratorPerProject")}
      anchor="experiments.orchestratorPerProject"
      description={t("experiments.orchestratorPerProjectDesc")}
      enabled={settings.state.experimentOrchestratorPerProject}
      onToggle={() =>
        settings.setExperimentOrchestratorPerProject(
          !settings.state.experimentOrchestratorPerProject,
        )}
    />
  </div>
{/if}

<ToggleSetting
  label={t("experiments.voice")} anchor="experiments.voice"
  description={t("experiments.voiceDesc")}
  enabled={settings.state.experimentVoice}
  onToggle={() => settings.setExperimentVoice(!settings.state.experimentVoice)}
/>

{#if settings.state.experimentVoice}
  <VoiceSettings />
{/if}

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
      use:tip={sortManual ? t("experiments.smartSortDirManual") : undefined}
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
  label={t("experiments.whip")} anchor="experiments.whip"
  description={t("experiments.whipDesc")}
  enabled={settings.state.experimentWhip}
  onToggle={() => settings.setExperimentWhip(!settings.state.experimentWhip)}
/>

{#if settings.state.experimentWhip}
  <div class="flex flex-col gap-1 pl-3">
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label={t("experiments.whipSound")}
    >
      <span class="w-20 shrink-0 text-xs text-muted-foreground">
        {t("experiments.whipSound")}
      </span>
      {#each WHIP_SOUNDS as sound (sound.id)}
        <button
          type="button"
          role="radio"
          aria-checked={whipSoundOn(sound.id)}
          class={whipSoundOn(sound.id) ? RADIO_ON : RADIO}
          onclick={() => {
            settings.setWhipSound(sound.id);
            // The click is the gesture that unlocks audio, so picking a noise
            // is also the only honest way to hear it: a label cannot say what
            // a crack sounds like.
            void playPreview(sound.id);
          }}
        >
          {t(sound.labelKey)}
        </button>
      {/each}
    </div>
    <p class="text-xs text-muted-foreground">{t("experiments.whipSoundDesc")}</p>
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
