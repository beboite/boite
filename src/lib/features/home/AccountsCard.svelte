<script lang="ts">
  import { onMount } from "svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { kebaccSwitcher, codexSwitcher } from "$lib/features/plugin/store.svelte";
  import {
    formatReset,
    rowFromCodexSwitcher,
    rowFromKebacc,
    windowPercent,
    type AccountRow,
  } from "$lib/features/plugin/accounts";
  import { ACCOUNT_PROVIDERS, type AccountProvider } from "$lib/features/plugin/restart";
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import { relativeClock } from "$lib/shared/utils/clock.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import Users from "@lucide/svelte/icons/users";

  const LABEL: Record<AccountProvider, MessageKey> = {
    claude: "plugin.kebaccClaude",
    codex: "plugin.kebaccCodex",
    antigravity: "plugin.kebaccAntigravity",
  };

  let picked = $state<AccountProvider>("claude");

  const enabled = $derived(
    ACCOUNT_PROVIDERS.filter((id) => {
      if (id === "claude") return settings.state.kebaccClaude;
      if (id === "codex") return settings.state.kebaccCodex;
      return settings.state.kebaccAntigravity;
    }),
  );

  const tab = $derived(enabled.includes(picked) ? picked : (enabled[0] ?? "claude"));

  const available = $derived(
    kebaccSwitcher.installed === true ||
      (settings.state.kebaccCodex && codexSwitcher.installed === true),
  );

  const probing = $derived(kebaccSwitcher.probing || codexSwitcher.probing);
  const show = $derived(enabled.length > 0 && (available || probing || kebaccSwitcher.installed === null));

  const switching = $derived(kebaccSwitcher.switching || codexSwitcher.switching);

  function accountsFor(provider: AccountProvider): AccountRow[] {
    const kebaccRows = kebaccSwitcher
      .accountsOf(provider)
      .map((account) => rowFromKebacc(provider, account));
    if (provider !== "codex") return kebaccRows;
    if (kebaccRows.length > 0) return kebaccRows;
    if (codexSwitcher.installed === true) {
      return (codexSwitcher.accounts ?? []).map(rowFromCodexSwitcher);
    }
    return kebaccRows;
  }

  const accounts = $derived(accountsFor(tab));

  function tabLabel(id: AccountProvider): string {
    return kebaccSwitcher.labelOf(id) ?? t(LABEL[id]);
  }

  async function activate(row: AccountRow): Promise<void> {
    if (row.active || switching) return;
    const n =
      row.source === "codex-switcher"
        ? await codexSwitcher.activate(row.id)
        : await kebaccSwitcher.switchTo(row.provider, row.email);
    const err = row.source === "codex-switcher" ? codexSwitcher.error : kebaccSwitcher.error;
    if (err) {
      notifications.error(t("plugin.switchFailed", { error: err }));
      return;
    }
    notifications.success(
      n === 0 ? t("plugin.switchedNone") : t("plugin.switched", { count: n }),
    );
  }

  onMount(() => {
    void kebaccSwitcher.probe();
    void codexSwitcher.probe();
  });
</script>

{#if show}
  <DashboardCard title={t("home.accounts")} badge={accounts.length || null} flush>
    {#snippet icon()}<Users class="size-3.5" />{/snippet}
    {#if enabled.length > 1}
      <div class="flex flex-wrap gap-1 px-3.5 pb-2">
        {#each enabled as id (id)}
          <button
            type="button"
            class="rounded-sm px-1.5 py-0.5 text-2xs uppercase tracking-wider transition {tab === id
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
            aria-pressed={tab === id}
            onclick={() => (picked = id)}
          >
            {tabLabel(id)}
          </button>
        {/each}
      </div>
    {/if}
    {#if probing && kebaccSwitcher.installed === null && codexSwitcher.installed === null}
      <p class="px-3.5 pb-3 text-sm text-muted-foreground">{t("common.loading")}</p>
    {:else if accounts.length === 0}
      <p class="px-3.5 pb-3 text-sm text-muted-foreground">{t("home.noAccounts")}</p>
    {:else}
      <ul class="flex max-h-64 flex-col overflow-y-auto px-2 pb-2">
        {#each accounts as account (account.id)}
          <li>
            <button
              type="button"
              class="group flex w-full items-baseline gap-2 rounded-sm px-1.5 py-1.5 text-left text-xs transition hover:bg-accent disabled:opacity-60"
              disabled={switching || account.active}
              onclick={() => void activate(account)}
            >
              <span
                class="min-w-0 truncate text-foreground [@media(hover:hover)]:blur-[6px] [@media(hover:hover)]:transition [@media(hover:hover)]:group-hover:blur-none [@media(hover:hover)]:group-focus-visible:blur-none"
              >
                {account.email}
              </span>
              {#if account.active}
                <span class="shrink-0 text-2xs uppercase tracking-wider text-muted-foreground/70">
                  {t("plugin.current")}
                </span>
              {/if}
              <span class="ml-auto flex min-w-0 shrink-0 flex-wrap justify-end gap-x-2 text-muted-foreground/70">
                {#each account.windows as window (window.label)}
                  {@const percent = windowPercent(window)}
                  {@const reset = formatReset(window.reset, relativeClock.now)}
                  {#if percent || reset}
                    <span class="tabular-nums">
                      {window.label}{percent ? ` ${percent}` : ""}{reset ? ` ${reset}` : ""}
                    </span>
                  {/if}
                {/each}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </DashboardCard>
{/if}
