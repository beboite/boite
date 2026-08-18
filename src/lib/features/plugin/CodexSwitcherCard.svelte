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
  import {
    CODEX_SWITCHER_REPO,
    installCommand,
    uninstallCommand,
    updateCommand,
  } from "./install";
  import { installer } from "./installer.svelte";
  import { codexSwitcher } from "./store.svelte";

  let { anchor }: { anchor: MessageKey } = $props();

  const installed = $derived(codexSwitcher.installed === true);
  const cargoMissing = $derived(codexSwitcher.cargoPresent === false);
  const install = installCommand();
  const update = updateCommand();
  const uninstall = uninstallCommand();
  const primary = $derived(installed ? update : install);

  function line(c: { cmd: string; args: string[] }): string {
    return [c.cmd, ...c.args].join(" ");
  }

  const verdict = $derived.by(() => {
    switch (installer.status) {
      case "running":
        switch (installer.action) {
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
        const cmd = installer.action === "update" ? update.cmd : install.cmd;
        return installer.failure
          ? t("plugin.failedToStart", { cmd, error: installer.failure })
          : t("plugin.failedWithCode", { cmd, code: installer.exitCode ?? "?" });
      }
      default:
        return null;
    }
  });

  const verdictClass = $derived(
    installer.status === "failed"
      ? "text-[var(--color-danger)]"
      : installer.status === "done"
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
    void installer.lines.length;
    if (!logBox || !pinned) return;
    logBox.scrollTop = logBox.scrollHeight;
  });

  function copyLog(): void {
    void navigator.clipboard.writeText(installer.lines.join("\n"));
    notifications.success(t("plugin.logCopied"));
  }

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

  onMount(() => {
    void codexSwitcher.probe();
  });
</script>

<SettingsCard title={t("plugin.codexTitle")} {anchor} description={t("plugin.codexDesc")}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      onclick={() => codexSwitcher.probe()}
      disabled={codexSwitcher.probing || installer.busy}
      title={t("plugin.recheck")}
    >
      <RefreshCw class="size-3 {codexSwitcher.probing ? 'animate-spin' : ''}" />
      {t("plugin.recheck")}
    </button>
  {/snippet}

  <div class="flex items-center gap-2 text-xs">
    <span
      class="size-1.5 shrink-0 rounded-full"
      style:background-color={installed ? "var(--color-success)" : "var(--color-border)"}
    ></span>
    {#if codexSwitcher.probing && codexSwitcher.installed === null}
      <span class="text-muted-foreground">{t("common.loading")}</span>
    {:else if installed}
      <span class="text-foreground">{t("plugin.installed")}</span>
      {#if codexSwitcher.version}
        <span class="tabular-nums text-xs text-muted-foreground/70">v{codexSwitcher.version}</span>
      {/if}
    {:else}
      <span class="text-muted-foreground">{t("plugin.notInstalled")}</span>
    {/if}
  </div>

  <div class="flex flex-wrap items-center gap-1.5 pt-1">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
      onclick={() => (installed ? installer.update() : installer.install())}
      disabled={(!installed && cargoMissing) || installer.busy}
      title={line(primary)}
    >
      <Download class="size-3" />
      {installed ? t("plugin.update") : t("plugin.install")}
    </button>
    {#if installed}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-40"
        onclick={() => installer.uninstall()}
        disabled={cargoMissing || installer.busy}
        title={line(uninstall)}
      >
        <Trash2 class="size-3" />
        {t("plugin.uninstall")}
      </button>
    {/if}
    {#if installer.busy}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
        onclick={() => installer.cancel()}
      >
        <Square class="size-3" />
        {t("plugin.stop")}
      </button>
    {:else if installer.status === "failed" || installer.status === "cancelled"}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30"
        onclick={() => installer.retry()}
      >
        <RotateCw class="size-3" />
        {t("plugin.retry")}
      </button>
    {/if}
  </div>

  {#if verdict}
    <div class="flex items-center justify-between gap-2 pt-1 text-xs">
      <span class={verdictClass}>{verdict}</span>
      {#if !installer.busy && installer.hasOutput}
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
            onclick={() => installer.dismiss()}
          >
            {t("plugin.clearLog")}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  {#if installer.busy || installer.lines.length > 0}
    <div
      bind:this={logBox}
      onscroll={onLogScroll}
      class="max-h-52 min-h-24 overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-xs leading-snug"
    >
      {#each installer.lines as text}
        <div class="break-words whitespace-pre-wrap text-foreground/80">{text}</div>
      {/each}
    </div>
  {/if}

  {#if cargoMissing && !installed}
    <p class="text-xs leading-snug text-[var(--color-warning)]">
      {t("plugin.needsCargo")}
    </p>
  {/if}

  {#if codexSwitcher.error}
    <p class="text-xs leading-snug text-[var(--color-danger)]">{codexSwitcher.error}</p>
  {/if}

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

  <p class="pt-0.5 text-xs text-muted-foreground/60">{CODEX_SWITCHER_REPO}</p>
</SettingsCard>
