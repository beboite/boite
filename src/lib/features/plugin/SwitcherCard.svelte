<script lang="ts">
  import { onMount } from "svelte";
  import type { PluginKind } from "$lib/backend/types";
  import type { MessageKey } from "$lib/i18n/index.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { accountsOf, isJsonStatus, statusText } from "./status";
  import { switcherFor } from "./store.svelte";

  let { kind, anchor }: { kind: PluginKind; anchor: MessageKey } = $props();

  const store = $derived(switcherFor(kind));
  const titleKey: MessageKey = $derived(
    kind === "claude" ? "plugin.claudeTitle" : "plugin.codexTitle",
  );
  const descKey: MessageKey = $derived(
    kind === "claude" ? "plugin.claudeDesc" : "plugin.codexDesc",
  );
  const contractKey: MessageKey = $derived(
    kind === "claude" ? "plugin.claudeContract" : "plugin.codexContract",
  );
  const installed = $derived(store.installed === true);
  const accounts = $derived(accountsOf(store.status));
  const raw = $derived(statusText(store.status));

  async function flip(who: string): Promise<void> {
    const n = await store.switchTo(who);
    if (store.error) {
      notifications.error(t("plugin.switchFailed", { error: store.error }));
      return;
    }
    notifications.success(
      n === 0 ? t("plugin.switchedNone") : t("plugin.switched", { count: n }),
    );
  }

  onMount(() => {
    void store.probe();
  });
</script>

<SettingsCard title={t(titleKey)} {anchor} description={t(descKey)}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      onclick={() => store.probe()}
      disabled={store.loading || store.switching}
      title={t("plugin.recheck")}
    >
      <RefreshCw class="size-3 {store.loading ? 'animate-spin' : ''}" />
      {t("plugin.recheck")}
    </button>
  {/snippet}

  <div class="flex items-center gap-2 text-xs">
    <span
      class="size-1.5 shrink-0 rounded-full"
      style:background-color={installed ? "var(--color-success)" : "var(--color-border)"}
    ></span>
    {#if store.loading && store.installed === null}
      <span class="text-muted-foreground">{t("common.loading")}</span>
    {:else if installed}
      <span class="text-foreground">{t("plugin.installed")}</span>
      {#if store.version}
        <span class="tabular-nums text-xs text-muted-foreground/70">{store.version}</span>
      {/if}
    {:else}
      <span class="text-muted-foreground">{t("plugin.notInstalled")}</span>
    {/if}
  </div>

  {#if store.error}
    <p class="text-xs leading-snug text-[var(--color-danger)]">{store.error}</p>
  {/if}

  {#if installed && isJsonStatus(store.status)}
    {#if accounts.length === 0}
      <p class="text-xs text-muted-foreground">{t("plugin.noAccounts")}</p>
    {:else}
      <ul class="flex flex-col gap-1">
        {#each accounts as account (account.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-baseline gap-2 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-left text-xs transition hover:border-foreground/30 disabled:opacity-50"
              disabled={store.switching || account.current}
              onclick={() => void flip(account.id)}
            >
              <span class="min-w-0 truncate text-foreground">
                {account.label ?? account.id}
              </span>
              {#if account.current}
                <span class="shrink-0 text-2xs uppercase tracking-wider text-muted-foreground/70">
                  {t("plugin.current")}
                </span>
              {/if}
              {#if account.limited}
                <span class="shrink-0 text-2xs text-[var(--color-warning)]">
                  {t("plugin.limited")}
                </span>
              {/if}
              {#if account.usage}
                <span class="ml-auto shrink-0 tabular-nums text-muted-foreground/70">
                  {account.usage}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if installed && raw}
    <p class="text-xs text-muted-foreground">{t("plugin.rawStatus")}</p>
    <pre
      class="max-h-40 overflow-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-xs leading-snug text-foreground/80 whitespace-pre-wrap"
    >{raw}</pre>
  {/if}

  {#if installed}
    <button
      type="button"
      class="rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={store.switching}
      onclick={() => void flip("next")}
    >
      {store.switching ? t("plugin.switching") : t("plugin.switchNext")}
    </button>
  {:else if store.installed === false}
    <p class="text-xs leading-snug text-muted-foreground/80">{t("plugin.missingHint")}</p>
  {/if}

  <p class="pt-0.5 text-xs text-muted-foreground/60">{t(contractKey)}</p>
</SettingsCard>
