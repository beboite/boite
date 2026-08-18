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

  async function activate(id: string): Promise<void> {
    const n = await codexSwitcher.activate(id);
    if (codexSwitcher.error) {
      notifications.error(t("plugin.switchFailed", { error: codexSwitcher.error }));
      return;
    }
    notifications.success(
      n === 0 ? t("plugin.switchedNone") : t("plugin.switched", { count: n }),
    );
  }

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
      class="rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={codexSwitcher.switching}
      onclick={() => void saveCurrent()}
    >
      {t("plugin.saveCurrent")}
    </button>

    {#if codexSwitcher.accounts.length === 0}
      <p class="text-xs text-muted-foreground">{t("plugin.noAccounts")}</p>
    {:else}
      <ul class="flex flex-col gap-1">
        {#each codexSwitcher.accounts as account (account.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-baseline gap-2 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-left text-xs transition hover:border-foreground/30 disabled:opacity-50"
              disabled={codexSwitcher.switching || account.is_active}
              onclick={() => void activate(account.id)}
            >
              <span class="min-w-0 truncate text-foreground">{account.email}</span>
              {#if account.is_active}
                <span class="shrink-0 text-2xs uppercase tracking-wider text-muted-foreground/70">
                  {t("plugin.current")}
                </span>
              {/if}
              {#if account.plan_label}
                <span class="shrink-0 text-muted-foreground/70">{account.plan_label}</span>
              {/if}
              {#if account.usage?.weekly}
                <span class="ml-auto shrink-0 tabular-nums text-muted-foreground/70">
                  {account.usage.weekly.remaining_percent}%
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</PluginInstallCard>
