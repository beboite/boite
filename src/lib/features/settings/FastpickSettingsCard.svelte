<script lang="ts">
  import { fastpick } from "$lib/features/fastpick/store.svelte";
  import { installer } from "$lib/features/fastpick/installer.svelte";
  import {
    FASTPICK_REPO,
    installCommand,
    uninstallCommand,
    updateCommand,
  } from "$lib/features/fastpick/install";
  import PluginInstallCard from "$lib/features/plugin/PluginInstallCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";

  let { anchor, enableAnchor }: { anchor: MessageKey; enableAnchor: MessageKey } = $props();
</script>

<PluginInstallCard
  {anchor}
  title={t("fastpick.settingsTitle")}
  description={t("fastpick.settingsDesc")}
  repo={FASTPICK_REPO}
  install={installCommand()}
  update={updateCommand()}
  uninstall={uninstallCommand()}
  probe={fastpick}
  {installer}
  runningUpdateKey="fastpick.runningUpdate"
>
  <ToggleSetting
    label={t("fastpick.enable")}
    anchor={enableAnchor}
    description={t("fastpick.enableDesc")}
    enabled={settings.state.fastpickEnabled}
    onToggle={() => void settings.setFastpickEnabled(!settings.state.fastpickEnabled)}
  />
  <p class="pt-1 text-xs leading-snug text-muted-foreground/80">
    {t("fastpick.runsHere")}
  </p>
  <p class="text-xs leading-snug text-muted-foreground/80">
    {t("fastpick.keepsConfig")}
  </p>
  {#if fastpick.cargoPresent === false && fastpick.installed !== true}
    <p class="text-xs leading-snug text-[var(--color-warning)]">
      {t("fastpick.needsCargoHelp")}
    </p>
  {/if}
</PluginInstallCard>
