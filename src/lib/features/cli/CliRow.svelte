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
  import Button from "$lib/shared/components/Button.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { CliRow } from "$lib/backend";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
  import { cliManager, settled } from "./store.svelte";
  import { action, blocker, removable } from "./rules";
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
  const latest = $derived(cliManager.latestFor(row.id));
  // What the button does, which is also the only thing it may be called. A row
  // that is current says so instead of offering an update to the version it has.
  const primaryAction = $derived(action(row, latest));

  /**
   * The button's own tooltip carries what used to be a paragraph under every
   * managed row: which package manager runs, and the exact command line it is
   * handed. Ten rows do not need to say it in prose; the one row being clicked
   * does.
   */
  const buttonHint = $derived.by(() => {
    if (row.source !== "managed") return undefined;
    const cmd = commandLine(row.installed ? "update" : "install");
    return row.requires ? `${t("cli.runsInTerminal", { tool: row.requires })}
${cmd}` : cmd;
  });

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
  function commandLine(which: "install" | "update" | "uninstall" | null): string {
    const argv =
      which === "uninstall"
        ? row.uninstallCommand
        : which === "update"
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
        <span class="truncate text-sm font-medium text-foreground">{label}</span>
        {#if row.version}
          <span class="shrink-0 tabular-nums text-xs text-muted-2">v{row.version}</span>
        {/if}
        {#if primaryAction === "update" && latest}
          <span class="shrink-0 tabular-nums text-xs text-[var(--color-warning)]">v{latest}</span>
        {/if}
      </span>
      <span class="flex items-center gap-1.5">
        <span
          class="size-1.5 shrink-0 rounded-full"
          style:background-color={row.installed
            ? "var(--color-success)"
            : row.unlinked
              ? "var(--color-warning)"
              : "var(--color-border)"}
        ></span>
        <span
          class="truncate text-sm text-muted-foreground"
          title={row.path ?? row.unlinked ?? undefined}
        >
          {#if !row.installed && row.unlinked}
            {t("cli.unlinked", { path: row.unlinked })}
          {:else if !row.installed}
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
          class="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition hover:bg-[var(--color-surface-3)] hover:text-foreground"
          title={t("cli.docs")}
          aria-label={t("cli.docs")}
        >
          <ExternalLink class="size-3" />
        </a>
      {/if}
      {#if row.source !== "manual"}
        <Button
          variant={primaryAction === "update" ? "primary" : "secondary"}
          onclick={primary}
          disabled={busy || blocked !== null}
          title={buttonHint}
        >
          <Download class="size-3" />
          {primaryAction === "install"
            ? t("cli.install")
            : primaryAction === "update"
              ? t("cli.update")
              : t("cli.reinstall")}
        </Button>
      {/if}
      {#if removable(row)}
        <Button variant="danger" onclick={remove} disabled={busy}>
          <Trash2 class="size-3" />
          {t("cli.uninstall")}
        </Button>
      {/if}
      {#if running}
        <Button variant="danger" onclick={() => cliManager.cancel(row.id)}>
          <Square class="size-3" />
          {t("cli.stop")}
        </Button>
      {:else if terminalBusy}
        <Button variant="danger" onclick={() => installer?.cancel()}>
          <Square class="size-3" />
          {t("cli.stop")}
        </Button>
      {/if}
    </div>
  </div>

  <!-- Only what the row cannot say in its own line. A version already on screen
       beside a button reading "Update" says "up to date" and "1.2.3 is out"
       twice over, and ten rows repeating either is the noise this drops. What is
       left is the one case a reader has to act on: the manager is missing. -->
  {#if blocked}
    <p class="flex flex-wrap items-baseline gap-2 text-sm text-muted-2">
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
  {/if}

  {#if job}
    <div class="flex items-center justify-between gap-2">
      <span class="text-sm {phaseClass}">{phaseText}</span>
      {#if settled(job)}
        <div class="flex shrink-0 items-center gap-2">
          {#if job.phase !== "done" && job.kind === "install"}
            <Button variant="ghost" size="sm" onclick={() => cliManager.retry(row.id)}>
              <RotateCw class="size-3" />
              {t("cli.retry")}
            </Button>
          {/if}
          <Button variant="ghost" size="sm" onclick={() => cliManager.dismiss(row.id)}>
            {t("cli.dismiss")}
          </Button>
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
      <span class="text-sm {terminalClass}">{terminalVerdict}</span>
      {#if !installer.busy}
        <div class="flex shrink-0 items-center gap-2">
          {#if installer.status === "failed" || installer.status === "cancelled"}
            <Button variant="ghost" size="sm" onclick={() => installer?.retry()}>
              <RotateCw class="size-3" />
              {t("cli.retry")}
            </Button>
          {/if}
          {#if installer.hasOutput}
            <Button variant="ghost" size="sm" onclick={() => installer?.dismiss()}>
              {t("cli.dismiss")}
            </Button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if installer && (installer.busy || installer.lines.length > 0)}
    <div
      class="max-h-40 overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-sm"
    >
      {#each installer.lines as line}
        <div class="break-words whitespace-pre-wrap text-foreground">{line}</div>
      {/each}
    </div>
  {/if}
</div>

{#if asking}
  <CliUninstallDialog {row} {label} onClose={() => (asking = false)} onConfirm={confirmRemoval} />
{/if}
