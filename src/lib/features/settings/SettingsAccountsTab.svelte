<script lang="ts">
  import { onMount } from "svelte";
  import { accounts } from "$lib/features/accounts/store.svelte";
  import { installer } from "$lib/features/accounts/installer.svelte";
  import {
    doctorCommand,
    installCommand,
    packageVersion,
    uninstallCommand,
    updateCommand,
  } from "$lib/features/accounts/install";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Download from "@lucide/svelte/icons/download";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Square from "@lucide/svelte/icons/square";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import Stethoscope from "@lucide/svelte/icons/stethoscope";
  import { t } from "$lib/i18n/index.svelte";

  const installed = $derived(accounts.installed === true);
  const pwshMissing = $derived(accounts.pwshPresent === false);
  const install = installCommand();
  const update = updateCommand();
  const uninstall = uninstallCommand();
  const doctor = doctorCommand();

  // Update is the installer run a second time, so the two differ only in what
  // the button says.
  const primary = $derived(installed ? update : install);

  function line(c: { cmd: string; args: string[] }): string {
    return [c.cmd, ...c.args].join(" ");
  }

  // What this build carries, which is what an install or an update leaves
  // behind. Worth saying only when it is not what is already on the machine.
  const shipped = packageVersion();

  /** What the run has to say about itself, or null while it has said nothing. */
  const verdict = $derived.by(() => {
    switch (installer.status) {
      case "running":
        switch (installer.action) {
          case "uninstall":
            return t("accounts.runningUninstall");
          case "update":
            return t("accounts.runningUpdate");
          case "doctor":
            return t("accounts.runningDoctor");
          default:
            return t("accounts.runningInstall");
        }
      case "done":
        return t("accounts.finished");
      case "cancelled":
        return t("accounts.cancelled");
      case "failed": {
        // The command that failed, not the one the button offers now.
        const cmd = installer.action === "doctor" ? doctor.cmd : install.cmd;
        return installer.failure
          ? t("accounts.failedToStart", { cmd, error: installer.failure })
          : t("accounts.failedWithCode", { cmd, code: installer.exitCode ?? "?" });
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

  // Pinned rather than followed, for the reason the fastpick card gives: a user
  // who has scrolled up is reading something.
  let logBox = $state<HTMLDivElement | null>(null);
  let pinned = $state(true);

  function onLogScroll(): void {
    if (!logBox) return;
    const slack = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight;
    pinned = slack < 24;
  }

  $effect(() => {
    // Read so the effect re-runs on each repaint, not only on the first.
    void installer.lines.length;
    if (!logBox || !pinned) return;
    logBox.scrollTop = logBox.scrollHeight;
  });

  function copyLog(): void {
    void navigator.clipboard.writeText(installer.lines.join("\n"));
    notifications.success(t("accounts.logCopied"));
  }

  onMount(() => {
    void accounts.probe();
  });
</script>

<SettingsCard title={t("accounts.settingsTitle")} anchor="accounts.settingsTitle" description={t("accounts.settingsDesc")}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      onclick={() => accounts.probe()}
      disabled={accounts.probing}
      title={t("accounts.recheck")}
    >
      <RefreshCw class="size-3 {accounts.probing ? 'animate-spin' : ''}" />
      {t("accounts.recheck")}
    </button>
  {/snippet}

  <div class="flex items-center gap-2 text-xs">
    <span
      class="size-1.5 shrink-0 rounded-full"
      style:background-color={installed ? "var(--color-success)" : "var(--color-border)"}
    ></span>
    {#if accounts.probing && accounts.installed === null}
      <span class="text-muted-foreground">{t("common.loading")}</span>
    {:else if installed}
      <span class="text-foreground">{t("accounts.installed")}</span>
      {#if accounts.version}
        <span class="tabular-nums text-xs text-muted-foreground/70">v{accounts.version}</span>
      {/if}
      {#if accounts.version && accounts.version !== shipped}
        <span class="text-xs text-[var(--color-warning)]"
          >{t("accounts.updateAvailable", { version: shipped })}</span
        >
      {/if}
    {:else}
      <span class="text-muted-foreground">{t("accounts.notInstalled")}</span>
    {/if}
  </div>

  <!-- The pools outlive the tools, so they are worth saying even on a machine
       where nothing is installed: they are what a reinstall would find again. -->
  {#if accounts.claudeAccounts !== null || accounts.codexAccounts !== null}
    <p class="text-xs text-muted-foreground/80">
      {t("accounts.savedAccounts", {
        claude: accounts.claudeAccounts ?? 0,
        codex: accounts.codexAccounts ?? 0,
      })}
    </p>
  {/if}

  <div class="flex flex-wrap items-center gap-1.5 pt-1">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
      onclick={() => (installed ? installer.update() : installer.install())}
      disabled={pwshMissing || installer.busy}
      title={line(primary)}
    >
      <Download class="size-3" />
      {installed ? t("accounts.update") : t("accounts.install")}
    </button>
    {#if installed}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        onclick={() => installer.doctor()}
        disabled={pwshMissing || installer.busy}
        title={line(doctor)}
      >
        <Stethoscope class="size-3" />
        {t("accounts.doctor")}
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-40"
        onclick={() => installer.uninstall()}
        disabled={pwshMissing || installer.busy}
        title={line(uninstall)}
      >
        <Trash2 class="size-3" />
        {t("accounts.uninstall")}
      </button>
    {/if}
    {#if installer.busy}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
        onclick={() => installer.cancel()}
      >
        <Square class="size-3" />
        {t("accounts.stop")}
      </button>
    {:else if installer.status === "failed" || installer.status === "cancelled"}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30"
        onclick={() => installer.retry()}
      >
        <RotateCw class="size-3" />
        {t("accounts.retry")}
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
            {t("accounts.copyLog")}
          </button>
          <button
            type="button"
            class="text-xs text-muted-foreground/70 transition hover:text-foreground"
            onclick={() => installer.dismiss()}
          >
            {t("accounts.clearLog")}
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
      <!-- Unkeyed on purpose: the tail rolls, so every line's content changes
           under a fixed position and there is no id to key on. -->
      {#each installer.lines as text}
        <div class="break-words whitespace-pre-wrap text-foreground/80">{text}</div>
      {/each}
    </div>
  {/if}

  <p class="pt-1 text-xs leading-snug text-muted-foreground/80">
    {t("accounts.runsHere")}
  </p>
  <p class="text-xs leading-snug text-muted-foreground/80">
    {t("accounts.keepsAccounts")}
  </p>
  {#if pwshMissing}
    <p class="text-xs leading-snug text-[var(--color-warning)]">
      {t("accounts.needsPwsh")}
      {t("accounts.needsPwshHelp")}
    </p>
  {/if}
  <p class="pt-0.5 text-xs text-muted-foreground/60">{t("accounts.vendored")}</p>
</SettingsCard>
