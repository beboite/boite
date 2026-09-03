<script lang="ts">
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import {
    CODEX_SWITCHER_REPO,
    installCommand,
    uninstallCommand,
    updateCommand,
  } from "./install";
  import { installer } from "./installer.svelte";
  import { codexSwitcher } from "./store.svelte";
  import PluginInstallCard from "./PluginInstallCard.svelte";

  let { anchor }: { anchor: MessageKey } = $props();

  const installed = $derived(codexSwitcher.installed === true);

  async function saveCurrent(): Promise<void> {
    await codexSwitcher.saveCurrent();
    if (codexSwitcher.error) {
      notifications.error(t("plugin.saveFailed", { error: codexSwitcher.error }));
      return;
    }
    notifications.success(t("plugin.saved"));
  }
</script>

<PluginInstallCard
  {anchor}
  title={t("plugin.codexTitle")}
  description={t("plugin.codexDesc")}
  repo={CODEX_SWITCHER_REPO}
  install={installCommand()}
  update={updateCommand()}
  uninstall={uninstallCommand()}
  probe={codexSwitcher}
  {installer}
>
  {#if installed}
    <button
      type="button"
      class="rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={codexSwitcher.switching}
      onclick={() => void saveCurrent()}
    >
      {t("plugin.saveCurrent")}
    </button>
  {/if}
</PluginInstallCard>
