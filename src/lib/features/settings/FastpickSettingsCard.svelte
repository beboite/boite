<script lang="ts">
  import { fastpick } from "$lib/features/fastpick/store.svelte";
  import { installer } from "$lib/features/fastpick/installer.svelte";
  import {
    FASTPICK_REPO,
    installCommand,
    uninstallCommand,
    updateCommand,
  } from "$lib/features/fastpick/install";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import PluginInstallCard from "$lib/features/plugin/PluginInstallCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import Copy from "@lucide/svelte/icons/copy";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";

  let { anchor, enableAnchor }: { anchor: MessageKey; enableAnchor: MessageKey } = $props();

  // Where fastpick read its answers on the machine that answered, which for a remote boite
  // is the server rather than this device. It is the first thing anyone needs when a
  // provider is missing from the menu, and it used to be findable only by running
  // `fastpick --paths` in a terminal.
  const paths = $derived(
    [
      { label: t("fastpick.configLabel"), value: fastpick.configPath },
      { label: t("fastpick.promptsLabel"), value: fastpick.promptsDir },
    ].filter((p): p is { label: string; value: string } => Boolean(p.value)),
  );

  function copyPath(value: string): void {
    void navigator.clipboard.writeText(value);
    notifications.success(t("fastpick.pathCopied"));
  }
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
  {#if fastpick.installed === true && paths.length > 0}
    <div class="flex flex-col gap-0.5">
      {#each paths as path (path.label)}
        <button
          type="button"
          class="group flex min-w-0 items-baseline gap-2 text-left text-xs text-muted-2 transition hover:text-foreground"
          onclick={() => copyPath(path.value)}
          title={path.value}
        >
          <span class="shrink-0">{path.label}</span>
          <span class="min-w-0 truncate font-mono text-2xs">{path.value}</span>
          <Copy class="size-3 shrink-0 opacity-0 transition group-hover:opacity-100" />
        </button>
      {/each}
    </div>
  {/if}

  <ToggleSetting
    label={t("fastpick.enable")}
    anchor={enableAnchor}
    description={t("fastpick.enableDesc")}
    enabled={settings.state.fastpickEnabled}
    onToggle={() => void settings.setFastpickEnabled(!settings.state.fastpickEnabled)}
  />
</PluginInstallCard>
