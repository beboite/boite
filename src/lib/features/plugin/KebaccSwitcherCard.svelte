<script lang="ts">
  import { onMount } from "svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Download from "@lucide/svelte/icons/download";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Square from "@lucide/svelte/icons/square";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import type { KebaccSwitcherAccount } from "$lib/backend/types";
  import {
    KEBACC_SWITCH_REPO,
    kebaccInstallCommand,
    kebaccUninstallCommand,
    kebaccUpdateCommand,
  } from "./install-kebacc";
  import { kebaccInstaller } from "./installer.svelte";
  import { kebaccSwitcher, type KebaccProvider } from "./store-kebacc.svelte";

  let { anchor }: { anchor: MessageKey } = $props();

  const installed = $derived(kebaccSwitcher.installed === true);
  const cargoMissing = $derived(kebaccSwitcher.cargoPresent === false);
  const install = kebaccInstallCommand();
  const update = kebaccUpdateCommand();
  const uninstall = kebaccUninstallCommand();
  const primary = $derived(installed ? update : install);

  const groups = [
    { id: "claude" as const, titleKey: "plugin.claude" as const, saveKey: "plugin.saveCurrentClaude" as const },
    { id: "codex" as const, titleKey: "plugin.codex" as const, saveKey: "plugin.saveCurrentCodex" as const },
  ];

  function line(c: { cmd: string; args: string[] }): string {
    return [c.cmd, ...c.args].join(" ");
  }

  function remaining(account: KebaccSwitcherAccount): number | null {
    const n =
      account.usage?.five_hour?.remaining_percent ??
      account.usage?.seven_day?.remaining_percent;
    return typeof n === "number" ? Math.round(n) : null;
  }

  function switchable(account: KebaccSwitcherAccount): boolean {
    if (account.active) return false;
    if (account.sealed === false) return false;
    if (account.trust && account.trust !== "trusted") return false;
    return true;
  }

  const verdict = $derived.by(() => {
    switch (kebaccInstaller.status) {
      case "running":
        switch (kebaccInstaller.action) {
          case "uninstall":
            return t("plugin.runningUninstall");
          case "update":
            return t("plugin.runningUpdate");
          default:
            return t("plugin.runningInstall");
        }
      case "done":
        return t("plugin.finished");
      case "cancelled":
        return t("plugin.cancelled");
      case "failed": {
        const cmd = kebaccInstaller.action === "update" ? update.cmd : install.cmd;
        return kebaccInstaller.failure
          ? t("plugin.failedToStart", { cmd, error: kebaccInstaller.failure })
          : t("plugin.failedWithCode", { cmd, code: kebaccInstaller.exitCode ?? "?" });
      }
      default:
        return null;
    }
  });

  const verdictClass = $derived(
    kebaccInstaller.status === "failed"
      ? "text-[var(--color-danger)]"
      : kebaccInstaller.status === "done"
        ? "text-[var(--color-success)]"
        : "text-muted-foreground",
  );

  let logBox = $state<HTMLDivElement | null>(null);
  let pinned = $state(true);

  function onLogScroll(): void {
    if (!logBox) return;
    const slack = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight;
    pinned = slack < 24;
  }

  $effect(() => {
    void kebaccInstaller.lines.length;
    if (!logBox || !pinned) return;
    logBox.scrollTop = logBox.scrollHeight;
  });

  function copyLog(): void {
    void navigator.clipboard.writeText(kebaccInstaller.lines.join("\n"));
    notifications.success(t("plugin.logCopied"));
  }

  function providerLabel(provider: KebaccProvider): string {
    return t(provider === "claude" ? "plugin.claude" : "plugin.codex");
  }

  async function activate(provider: KebaccProvider, email: string): Promise<void> {
    const n = await kebaccSwitcher.switchTo(provider, email);
    if (kebaccSwitcher.error) {
      notifications.error(t("plugin.switchFailed", { error: kebaccSwitcher.error }));
      return;
    }
    notifications.success(
      n === 0
        ? t("plugin.switchedNoneKebacc", { provider: providerLabel(provider) })
        : t("plugin.switchedKebacc", { count: n, provider: providerLabel(provider) }),
    );
  }

  async function saveCurrent(provider: KebaccProvider): Promise<void> {
    await kebaccSwitcher.saveCurrent(provider);
    if (kebaccSwitcher.error) {
      notifications.error(t("plugin.saveFailed", { error: kebaccSwitcher.error }));
      return;
    }
    notifications.success(t("plugin.savedKebacc", { provider: providerLabel(provider) }));
  }

  onMount(() => {
    void kebaccSwitcher.probe();
  });
</script>

<SettingsCard title={t("plugin.kebaccTitle")} {anchor} description={t("plugin.kebaccDesc")}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      onclick={() => kebaccSwitcher.probe()}
      disabled={kebaccSwitcher.probing || kebaccInstaller.busy}
      title={t("plugin.recheck")}
    >
      <RefreshCw class="size-3 {kebaccSwitcher.probing ? 'animate-spin' : ''}" />
      {t("plugin.recheck")}
    </button>
  {/snippet}

  <div class="flex items-center gap-2 text-xs">
    <span
      class="size-1.5 shrink-0 rounded-full"
      style:background-color={installed ? "var(--color-success)" : "var(--color-border)"}
    ></span>
    {#if kebaccSwitcher.probing && kebaccSwitcher.installed === null}
      <span class="text-muted-foreground">{t("common.loading")}</span>
    {:else if installed}
      <span class="text-foreground">{t("plugin.installed")}</span>
      {#if kebaccSwitcher.version}
        <span class="tabular-nums text-xs text-muted-foreground/70">v{kebaccSwitcher.version}</span>
      {/if}
    {:else}
      <span class="text-muted-foreground">{t("plugin.notInstalled")}</span>
    {/if}
  </div>

  <div class="flex flex-wrap items-center gap-1.5 pt-1">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
      onclick={() => (installed ? kebaccInstaller.update() : kebaccInstaller.install())}
      disabled={(!installed && cargoMissing) || kebaccInstaller.busy}
      title={line(primary)}
    >
      <Download class="size-3" />
      {installed ? t("plugin.update") : t("plugin.install")}
    </button>
    {#if installed}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-40"
        onclick={() => kebaccInstaller.uninstall()}
        disabled={cargoMissing || kebaccInstaller.busy}
        title={line(uninstall)}
      >
        <Trash2 class="size-3" />
        {t("plugin.uninstall")}
      </button>
    {/if}
    {#if kebaccInstaller.busy}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
        onclick={() => kebaccInstaller.cancel()}
      >
        <Square class="size-3" />
        {t("plugin.stop")}
      </button>
    {:else if kebaccInstaller.status === "failed" || kebaccInstaller.status === "cancelled"}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30"
        onclick={() => kebaccInstaller.retry()}
      >
        <RotateCw class="size-3" />
        {t("plugin.retry")}
      </button>
    {/if}
  </div>

  {#if verdict}
    <div class="flex items-center justify-between gap-2 pt-1 text-xs">
      <span class={verdictClass}>{verdict}</span>
      {#if !kebaccInstaller.busy && kebaccInstaller.hasOutput}
        <div class="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            class="flex items-center gap-1 text-xs text-muted-foreground/70 transition hover:text-foreground"
            onclick={copyLog}
          >
            <Copy class="size-3" />
            {t("plugin.copyLog")}
          </button>
          <button
            type="button"
            class="text-xs text-muted-foreground/70 transition hover:text-foreground"
            onclick={() => kebaccInstaller.dismiss()}
          >
            {t("plugin.clearLog")}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {#if kebaccInstaller.busy || kebaccInstaller.lines.length > 0}
    <div
      bind:this={logBox}
      onscroll={onLogScroll}
      class="max-h-52 min-h-24 overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-xs leading-snug"
    >
      {#each kebaccInstaller.lines as text, i (i)}
        <div class="break-words whitespace-pre-wrap text-foreground/80">{text}</div>
      {/each}
    </div>
  {/if}

  {#if cargoMissing && !installed}
    <p class="text-xs leading-snug text-[var(--color-warning)]">
      {t("plugin.needsCargo")}
    </p>
  {/if}

  {#if kebaccSwitcher.error}
    <p class="text-xs leading-snug text-[var(--color-danger)]">{kebaccSwitcher.error}</p>
  {/if}

  {#if installed}
    <p class="text-xs leading-snug text-muted-foreground">{t("plugin.autoOnLaunch")}</p>

    {#each groups as group (group.id)}
      {@const accounts = kebaccSwitcher.accountsOf(group.id)}
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-foreground">{t(group.titleKey)}</span>
          <button
            type="button"
            class="rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={kebaccSwitcher.switching}
            onclick={() => void saveCurrent(group.id)}
          >
            {t(group.saveKey)}
          </button>
        </div>
        {#if accounts.length === 0}
          <p class="text-xs text-muted-foreground">
            {t("plugin.noAccountsKebacc", { provider: t(group.titleKey) })}
          </p>
        {:else}
          <ul class="flex flex-col gap-1">
            {#each accounts as account (account.email)}
              {@const left = remaining(account)}
              <li>
                <button
                  type="button"
                  class="flex w-full items-baseline gap-2 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-left text-xs transition hover:border-foreground/30 disabled:opacity-50"
                  disabled={kebaccSwitcher.switching || !switchable(account)}
                  onclick={() => void activate(group.id, account.email)}
                >
                  <span class="min-w-0 truncate text-foreground">{account.email}</span>
                  {#if account.active}
                    <span class="shrink-0 text-2xs uppercase tracking-wider text-muted-foreground/70">
                      {t("plugin.current")}
                    </span>
                  {/if}
                  {#if account.trust && account.trust !== "trusted"}
                    <span class="shrink-0 text-2xs text-[var(--color-warning)]">
                      {t("plugin.untrusted")}
                    </span>
                  {/if}
                  {#if account.sealed === false}
                    <span class="shrink-0 text-2xs text-[var(--color-warning)]">
                      {t("plugin.unsealed")}
                    </span>
                  {/if}
                  {#if left !== null}
                    <span class="ml-auto shrink-0 tabular-nums text-muted-foreground/70">
                      {left}%
                    </span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  {/if}

  <p class="pt-0.5 text-xs text-muted-foreground/60">{KEBACC_SWITCH_REPO}</p>
</SettingsCard>
