<script lang="ts">
  import { notifications } from "$lib/features/notifications/store.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import {
    KEBACC_SWITCH_REPO,
    kebaccInstallCommand,
    kebaccUninstallCommand,
    kebaccUpdateCommand,
  } from "./install-kebacc";
  import { kebaccInstaller } from "./installer.svelte";
  import { kebaccSwitcher } from "./store.svelte";
  import type { AccountProvider } from "./restart";
  import PluginInstallCard from "./PluginInstallCard.svelte";

  let {
    anchor,
    claudeAnchor,
    codexAnchor,
    antigravityAnchor,
  }: {
    anchor: MessageKey;
    claudeAnchor: MessageKey;
    codexAnchor: MessageKey;
    antigravityAnchor: MessageKey;
  } = $props();

  const installed = $derived(kebaccSwitcher.installed === true);

  const toggles = $derived(
    [
      {
        id: "claude" as const,
        enabled: settings.state.kebaccClaude,
        anchor: claudeAnchor,
        labelKey: "plugin.kebaccClaude" as const,
        set: (v: boolean) => settings.setKebaccClaude(v),
      },
      {
        id: "codex" as const,
        enabled: settings.state.kebaccCodex,
        anchor: codexAnchor,
        labelKey: "plugin.kebaccCodex" as const,
        set: (v: boolean) => settings.setKebaccCodex(v),
      },
      {
        id: "antigravity" as const,
        enabled: settings.state.kebaccAntigravity,
        anchor: antigravityAnchor,
        labelKey: "plugin.kebaccAntigravity" as const,
        set: (v: boolean) => settings.setKebaccAntigravity(v),
      },
    ] satisfies {
      id: AccountProvider;
      enabled: boolean;
      anchor: MessageKey;
      labelKey: MessageKey;
      set: (v: boolean) => void;
    }[],
  );

  async function saveCurrent(provider: AccountProvider): Promise<void> {
    await kebaccSwitcher.saveCurrent(provider);
    if (kebaccSwitcher.error) {
      notifications.error(t("plugin.saveFailed", { error: kebaccSwitcher.error }));
      return;
    }
    notifications.success(t("plugin.saved"));
  }
</script>

<PluginInstallCard
  {anchor}
  title={t("plugin.kebaccTitle")}
  description={t("plugin.kebaccDesc")}
  repo={KEBACC_SWITCH_REPO}
  install={kebaccInstallCommand()}
  update={kebaccUpdateCommand()}
  uninstall={kebaccUninstallCommand()}
  probe={kebaccSwitcher}
  installer={kebaccInstaller}
>
  {#each toggles as row (row.id)}
    <ToggleSetting
      label={t(row.labelKey)}
      anchor={row.anchor}
      enabled={row.enabled}
      onToggle={() => row.set(!row.enabled)}
    />
  {/each}

  {#if installed}
    <div class="flex flex-wrap items-center gap-1.5 pt-1">
      {#each toggles as row (row.id)}
        {#if row.enabled}
          <button
            type="button"
            class="rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={kebaccSwitcher.switching}
            onclick={() => void saveCurrent(row.id)}
          >
            {t("plugin.saveProvider", { name: t(row.labelKey) })}
          </button>
        {/if}
      {/each}
    </div>
  {/if}
</PluginInstallCard>
