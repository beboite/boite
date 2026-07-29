<script lang="ts">
  import { onMount } from "svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { fastpick } from "$lib/features/fastpick/store.svelte";
  import {
    FASTPICK_REPO,
    installCommand,
    installFastpick,
    uninstallCommand,
    uninstallFastpick,
  } from "$lib/features/fastpick/install";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Download from "@lucide/svelte/icons/download";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { t } from "$lib/i18n/index.svelte";

  const installed = $derived(fastpick.installed === true);
  const cargoMissing = $derived(fastpick.cargoPresent === false);
  const install = installCommand();
  const uninstall = uninstallCommand();

  function line(c: { cmd: string; args: string[] }): string {
    return [c.cmd, ...c.args].join(" ");
  }

  onMount(() => {
    void fastpick.probe();
  });
</script>

<SettingsCard title={t("fastpick.settingsTitle")} description={t("fastpick.settingsDesc")}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      onclick={() => fastpick.probe()}
      disabled={fastpick.probing}
      title={t("fastpick.recheck")}
    >
      <RefreshCw class="size-3" />
      {t("fastpick.recheck")}
    </button>
  {/snippet}

  <div class="flex items-center gap-2 text-xs">
    <span
      class="size-1.5 shrink-0 rounded-full"
      style:background-color={installed ? "var(--color-success)" : "var(--color-border)"}
    ></span>
    {#if fastpick.probing && fastpick.installed === null}
      <span class="text-muted-foreground">{t("common.loading")}</span>
    {:else if installed}
      <span class="text-foreground">{t("fastpick.installed")}</span>
      {#if fastpick.version}
        <span class="font-mono text-[10.5px] text-muted-foreground/70">v{fastpick.version}</span>
      {/if}
    {:else}
      <span class="text-muted-foreground">{t("fastpick.notInstalled")}</span>
    {/if}
  </div>

  <div class="flex flex-wrap items-center gap-1.5 pt-1">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-[11px] text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
      onclick={() => installFastpick()}
      disabled={cargoMissing}
      title={line(install)}
    >
      <Download class="size-3" />
      {installed ? t("fastpick.update") : t("fastpick.install")}
    </button>
    {#if installed}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-40"
        onclick={() => uninstallFastpick()}
        disabled={cargoMissing}
        title={line(uninstall)}
      >
        <Trash2 class="size-3" />
        {t("fastpick.uninstall")}
      </button>
    {/if}
  </div>

  <!-- Both run as a thread rather than behind a spinner: a cargo build is minutes of
       output, and its own error message is the one worth reading. -->
  <p class="pt-1 text-[11px] leading-snug text-muted-foreground/80">
    {t("fastpick.runsInThread")}
  </p>
  <p class="text-[11px] leading-snug text-muted-foreground/80">
    {t("fastpick.keepsConfig")}
  </p>
  {#if cargoMissing}
    <p class="text-[11px] leading-snug text-[var(--color-warning)]">
      {t("fastpick.needsCargo")}
    </p>
  {/if}
  <p class="pt-0.5 font-mono text-[10.5px] text-muted-foreground/60">{FASTPICK_REPO}</p>
</SettingsCard>

<ToggleSetting
  label={t("fastpick.enable")}
  description={t("fastpick.enableDesc")}
  enabled={settings.state.fastpickEnabled}
  onToggle={() => settings.setFastpickEnabled(!settings.state.fastpickEnabled)}
/>
