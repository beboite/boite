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
  import { tip } from "$lib/shared/actions/tooltip";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import Users from "@lucide/svelte/icons/users";

  const LABEL: Record<AccountProvider, MessageKey> = {
    claude: "plugin.kebaccClaude",
    codex: "plugin.kebaccCodex",
    antigravity: "plugin.kebaccAntigravity",
  };

  // "5h 0%  7d 0%" repeated on every row, with nothing saying what 5h was. The
  // window becomes a column with a header instead; a label no switcher of ours
  // uses is kept as it came rather than dropped.
  const WINDOW_HEADER: Record<string, MessageKey> = {
    "5h": "home.accountsWindow5h",
    "7d": "home.accountsWindow7d",
  };

  function windowHeader(label: string): string {
    const key = WINDOW_HEADER[label.trim().toLowerCase()];
    return key ? t(key) : label;
  }

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

  /** Every window any row reports, in the order the first row named them. */
  const columns = $derived([
    ...new Set(accounts.flatMap((row) => row.windows.map((w) => w.label))),
  ]);

  function cell(row: AccountRow, label: string): string {
    const window = row.windows.find((w) => w.label === label);
    if (!window) return "";
    const percent = windowPercent(window);
    const reset = formatReset(window.reset, relativeClock.now);
    return [percent, reset].filter(Boolean).join(" ");
  }

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
            class="rounded-sm px-1.5 py-0.5 text-xs uppercase tracking-wider transition {tab === id
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
      {#if columns.length > 0}
        <div
          class="flex items-baseline gap-2 px-3.5 pb-1 text-xs uppercase tracking-wider text-muted-2"
        >
          <span class="min-w-0 flex-1 truncate">{t("home.accountsColumn")}</span>
          {#each columns as label (label)}
            <span class="w-24 shrink-0 truncate text-right" use:tip={windowHeader(label)}>
              {windowHeader(label)}
            </span>
          {/each}
        </div>
      {/if}
      <ul class="flex max-h-64 flex-col overflow-y-auto px-2 pb-2">
        {#each accounts as account (account.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-baseline gap-2 rounded-sm px-1.5 py-1.5 text-left text-xs transition hover:bg-accent {account.active
                ? 'bg-accent font-medium text-foreground'
                : switching
                  ? 'opacity-60'
                  : ''}"
              disabled={switching || account.active}
              aria-current={account.active ? "true" : undefined}
              use:tip={account.active ? t("plugin.current") : null}
              onclick={() => void activate(account)}
            >
              <!-- The name was blurred until hover, unconditionally, on a card
                   whose whole job is saying which login is live. No privacy
                   setting ever gated it, so nothing is left to gate. -->
              <span class="min-w-0 flex-1 truncate text-sm text-foreground">
                {account.email}
              </span>
              {#each columns as label (label)}
                <span class="w-24 shrink-0 truncate text-right tabular-nums text-muted-2">
                  {cell(account, label)}
                </span>
              {/each}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </DashboardCard>
{/if}
