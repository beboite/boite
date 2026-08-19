<!--
  One agent CLI: what this machine has, and the buttons that change it.

  Three rows in one, because a row that looked different per source would be three
  components disagreeing about the same three questions. What the source decides is
  who does the work: Boite downloads a binary, a package manager runs in a terminal
  underneath the row, and an agent that publishes neither keeps its documentation
  link.

  Every way this can fail has somewhere to be said. A download that stopped says why
  in the row, a package manager that exited non-zero says so above its own log, and a
  manager that is not on the machine disables the button *and* names the tool with a
  link to it — from one rule (`rules.ts`), so the sentence and the button can never
  disagree.
-->
<script lang="ts">
  import Download from "@lucide/svelte/icons/download";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Square from "@lucide/svelte/icons/square";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { CliRow } from "$lib/backend";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
  import { cliManager, settled } from "./store.svelte";
  import { blocker, removable } from "./rules";
  import CliUninstallDialog from "./CliUninstallDialog.svelte";

  let { row }: { row: CliRow } = $props();

  // Display only: the label, the brand glyph and the vendor's documentation. What
  // can be installed and where its data lives comes from Rust.
  const preset = $derived(CLI_PRESETS.find((p) => p.id === row.id) ?? null);
  const label = $derived(preset?.label ?? row.id);

  const job = $derived(cliManager.jobFor(row.id));
  const running = $derived(job !== null && !settled(job));
  const installer = $derived(cliManager.installerFor(row));
  const terminalBusy = $derived(installer?.busy === true);
  const busy = $derived(running || terminalBusy);
  const blocked = $derived(blocker(row));

  let asking = $state(false);

  const progress = $derived.by(() => {
    if (!job || job.phase !== "downloading" || !job.total) return null;
    return Math.min(1, job.received / job.total);
  });

  function bytes(count: number): string {
    if (count < 1024) return `${count} B`;
    const units = ["KB", "MB", "GB"];
    let value = count / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  const phaseText = $derived.by(() => {
    if (!job) return null;
    switch (job.phase) {
      case "resolving":
        return t("cli.phaseResolving");
      case "downloading":
        return job.total
          ? t("cli.progress", { done: bytes(job.received), total: bytes(job.total) })
          : t("cli.progressUnknown", { done: bytes(job.received) });
      case "verifying":
        return t("cli.phaseVerifying");
      case "unpacking":
        return t("cli.phaseUnpacking");
      case "installing":
        return t("cli.phaseInstalling");
      case "removing":
        return t("cli.phaseRemoving");
      case "purging":
        return t("cli.phasePurging");
      case "done":
        return job.version ? t("cli.doneVersion", { version: job.version }) : t("cli.done");
      case "failed":
        return t("cli.failed", { error: job.message ?? "" });
      case "cancelled":
        return t("cli.cancelled");
    }
  });

  const phaseClass = $derived(
    job?.phase === "failed"
      ? "text-[var(--color-danger)]"
      : job?.phase === "done"
        ? "text-[var(--color-success)]"
        : "text-muted-foreground",
  );

  /** The command line the package manager was asked to run, for its verdict. */
  function commandLine(action: "install" | "update" | "uninstall" | null): string {
    const argv =
      action === "uninstall"
        ? row.uninstallCommand
        : action === "update"
          ? row.updateCommand
          : row.installCommand;
    return (argv ?? []).join(" ");
  }

  /**
   * What came of the terminal run, in words.
   *
   * Without it the only account of a failed `gh extension install` was its own log,
   * which is where a reader looks *after* being told there is something to look for.
   */
  const terminalVerdict = $derived.by(() => {
    if (!installer) return null;
    const cmd = commandLine(installer.action);
    switch (installer.status) {
      case "running":
        return t("cli.terminalRunning", { cmd });
      case "done":
        return t("cli.done");
      case "cancelled":
        return t("cli.cancelled");
      case "failed":
        return installer.failure
          ? t("cli.terminalFailedToStart", { cmd, error: installer.failure })
          : t("cli.terminalFailedWithCode", { cmd, code: String(installer.exitCode ?? "") });
      case "idle":
        return null;
    }
  });

  const terminalClass = $derived(
    installer?.status === "failed"
      ? "text-[var(--color-danger)]"
      : installer?.status === "done"
        ? "text-[var(--color-success)]"
        : "text-muted-foreground",
  );

  function primary(): void {
    if (row.source === "managed") {
      const runner = installer;
      if (!runner) return;
      if (row.installed) void runner.update();
      else void runner.install();
      return;
    }
    void cliManager.install(row.id);
  }

  /**
   * Nothing is removed here. The dialog is the question, and it used to be asked
   * after the package manager had already been sent to remove the extension.
   */
  function remove(): void {
    asking = true;
  }

  function confirmRemoval(purgeData: boolean): void {
    if (row.source === "managed") {
      // Its own manager owns the binary, so that half runs in a terminal. Boite
      // installed nothing for it, which leaves the data as the only half to ask
      // Rust about — and only when it was asked for.
      void installer?.uninstall();
      if (purgeData) void cliManager.uninstall(row.id, true);
      return;
    }
    void cliManager.uninstall(row.id, purgeData);
  }
</script>

<div class="flex flex-col gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2">
  <div class="flex items-center gap-2.5">
    <span class="flex size-6 shrink-0 items-center justify-center rounded bg-[var(--color-surface-3)]">
      <ShortcutIcon iconKey={preset?.iconKey ?? null} size={13} />
    </span>
    <span class="min-w-0 flex-1">
      <span class="flex items-baseline gap-1.5">
        <span class="truncate text-xs font-medium text-foreground">{label}</span>
        {#if row.version}
          <span class="shrink-0 tabular-nums text-xs text-muted-foreground/70">v{row.version}</span>
        {/if}
      </span>
      <span class="flex items-center gap-1.5">
        <span
          class="size-1.5 shrink-0 rounded-full"
          style:background-color={row.installed ? "var(--color-success)" : "var(--color-border)"}
        ></span>
        <span class="truncate text-xs text-muted-foreground" title={row.path ?? undefined}>
          {#if !row.installed}
            {t("cli.notInstalled")}
          {:else if row.managed}
            {t("cli.managedByBoite")}
          {:else}
            {t("cli.installedElsewhere", { path: row.path ?? "" })}
          {/if}
        </span>
      </span>
    </span>

    <div class="flex shrink-0 items-center gap-1.5">
      {#if preset?.docUrl}
        <a
          href={preset.docUrl}
          target="_blank"
          rel="noreferrer"
          class="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground/70 transition hover:text-foreground"
          title={t("cli.docs")}
          aria-label={t("cli.docs")}
        >
          <ExternalLink class="size-3" />
        </a>
      {/if}
      {#if row.source !== "manual"}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-3)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
          onclick={primary}
          disabled={busy || blocked !== null}
          title={row.source === "managed"
            ? commandLine(row.installed ? "update" : "install")
            : undefined}
        >
          <Download class="size-3" />
          {row.installed ? t("cli.update") : t("cli.install")}
        </button>
      {/if}
      {#if removable(row)}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-40"
          onclick={remove}
          disabled={busy}
        >
          <Trash2 class="size-3" />
          {t("cli.uninstall")}
        </button>
      {/if}
      {#if running}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
          onclick={() => cliManager.cancel(row.id)}
        >
          <Square class="size-3" />
          {t("cli.stop")}
        </button>
      {:else if terminalBusy}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
          onclick={() => installer?.cancel()}
        >
          <Square class="size-3" />
          {t("cli.stop")}
        </button>
      {/if}
    </div>
  </div>

  {#if blocked}
    <p class="flex flex-wrap items-baseline gap-2 text-xs leading-snug text-muted-foreground/70">
      <span>{t(blocked.key, { tool: blocked.tool ?? "" })}</span>
      {#if blocked.url}
        <a
          href={blocked.url}
          target="_blank"
          rel="noreferrer"
          class="inline-flex items-center gap-1 text-[var(--color-warning)] underline decoration-dotted transition hover:text-foreground"
        >
          <ExternalLink class="size-3" />
          {t("cli.getTool", { tool: blocked.tool ?? "" })}
        </a>
      {/if}
    </p>
  {:else if row.source === "managed"}
    <p class="text-xs leading-snug text-muted-foreground/70">
      {t("cli.runsInTerminal", { tool: row.requires ?? "" })}
    </p>
  {/if}

  {#if job}
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs leading-snug {phaseClass}">{phaseText}</span>
      {#if settled(job)}
        <div class="flex shrink-0 items-center gap-2">
          {#if job.phase !== "done" && job.kind === "install"}
            <button
              type="button"
              class="flex items-center gap-1 text-xs text-muted-foreground/70 transition hover:text-foreground"
              onclick={() => cliManager.retry(row.id)}
            >
              <RotateCw class="size-3" />
              {t("cli.retry")}
            </button>
          {/if}
          <button
            type="button"
            class="text-xs text-muted-foreground/70 transition hover:text-foreground"
            onclick={() => cliManager.dismiss(row.id)}
          >
            {t("cli.dismiss")}
          </button>
        </div>
      {/if}
    </div>
    {#if job.phase === "downloading"}
      <!-- aria-valuenow stays off while the vendor sent no length: its absence is
           how ARIA spells indeterminate, and a number there would claim progress
           nobody can compute. -->
      <div
        class="h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]"
        role="progressbar"
        aria-label={t("cli.phaseDownloading")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
        aria-valuetext={progress === null ? t("cli.phaseDownloading") : undefined}
      >
        <div
          class="h-full rounded-full bg-foreground transition-[width] duration-200 {progress === null
            ? 'w-1/3 animate-pulse'
            : ''}"
          style={progress === null ? undefined : `width: ${(progress * 100).toFixed(1)}%`}
        ></div>
      </div>
    {/if}
  {/if}

  {#if installer && terminalVerdict}
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs leading-snug {terminalClass}">{terminalVerdict}</span>
      {#if !installer.busy}
        <div class="flex shrink-0 items-center gap-2">
          {#if installer.status === "failed" || installer.status === "cancelled"}
            <button
              type="button"
              class="flex items-center gap-1 text-xs text-muted-foreground/70 transition hover:text-foreground"
              onclick={() => installer?.retry()}
            >
              <RotateCw class="size-3" />
              {t("cli.retry")}
            </button>
          {/if}
          {#if installer.hasOutput}
            <button
              type="button"
              class="text-xs text-muted-foreground/70 transition hover:text-foreground"
              onclick={() => installer?.dismiss()}
            >
              {t("cli.dismiss")}
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if installer && (installer.busy || installer.lines.length > 0)}
    <div
      class="max-h-40 overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-xs leading-snug"
    >
      {#each installer.lines as line}
        <div class="break-words whitespace-pre-wrap text-foreground/80">{line}</div>
      {/each}
    </div>
  {/if}
</div>

{#if asking}
  <CliUninstallDialog {row} {label} onClose={() => (asking = false)} onConfirm={confirmRemoval} />
{/if}
