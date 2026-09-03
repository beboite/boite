<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import VoiceSettings from "$lib/features/voice/VoiceSettings.svelte";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";

  const RADIO =
    "rounded-md border px-3 py-1 text-sm transition border-border bg-[var(--color-surface-2)] text-muted-foreground hover:border-foreground/30 hover:text-foreground";
  const RADIO_ON =
    "rounded-md border px-3 py-1 text-sm transition border-foreground/40 bg-[var(--color-surface-3)] text-foreground";

  /**
   * Turning the experiment off unmounts the surface, and asks once whether the
   * live orchestrator threads should be put away with it. Their workers are
   * not touched either way: a spawned terminal belongs to the workspace, not
   * to the conductor that opened it, and "put away" is the sidebar's own
   * settle, reversible from there.
   */
  async function toggleWorkspace() {
    const next = !settings.state.experimentWorkspace;
    settings.setExperimentWorkspace(next);
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
</script>

<p class="px-3 text-sm text-muted-foreground">{t("experiments.intro")}</p>

<ToggleSetting
  label={t("experiments.workspace")} anchor="experiments.workspace"
  description={t("experiments.workspaceDesc")}
  enabled={settings.state.experimentWorkspace}
  onToggle={() => void toggleWorkspace()}
/>

<!-- Everything the one switch turns on, under it: the agent the orchestrator
     runs and the microphone it listens on. Hidden rather than disabled while
     the switch is off, because neither describes anything that exists yet. The
     per-project scopes are picked per project, on the dashboard and in the
     sidebar's own menu, so they have no row here. -->
{#if settings.state.experimentWorkspace}
  <div class="flex flex-col gap-1.5 pl-3">
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="radiogroup"
      aria-label={t("experiments.orchestratorAgent")}
    >
      <span class="w-20 shrink-0 truncate text-sm text-muted-foreground">
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
      <p class="text-sm text-amber-500">{t("experiments.orchestratorBrokered")}</p>
    {/if}
  </div>
  <VoiceSettings />
{/if}
