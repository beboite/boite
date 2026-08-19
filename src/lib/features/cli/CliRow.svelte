<!--
  One agent CLI: what this machine has, and the two buttons that change it.

  Three rows in one, because a row that looked different per source would be
  three components disagreeing about the same three questions. What the source
  decides is who does the work: Boite downloads a binary, a package manager runs
  in a terminal underneath the row, and an agent that publishes neither keeps its
  documentation link.
-->
<script lang="ts">
  import Download from "@lucide/svelte/icons/download";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import Square from "@lucide/svelte/icons/square";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import type { CliRow } from "$lib/backend";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
  import { cliManager, settled } from "./store.svelte";
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

  /** Whether the primary button can do anything, and if not, what to say instead. */
  const blocked = $derived.by(() => {
    if (row.source === "manual") return t("cli.manualOnly");
    if (!row.installable) return t("cli.noBuild");
    if (row.source === "managed" && row.requiresPresent === false) {
      return t("cli.needs", { tool: row.requires ?? "" });
    }
    return null;
  });

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
        >
          <Download class="size-3" />
          {row.installed ? t("cli.update") : t("cli.install")}
        </button>
      {/if}
      {#if row.installed && row.source !== "manual"}
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
    <p class="text-xs leading-snug text-muted-foreground/70">{blocked}</p>
  {:else if row.source === "managed"}
    <p class="text-xs leading-snug text-muted-foreground/70">
      {t("cli.runsInTerminal", { tool: row.requires ?? "" })}
    </p>
  {/if}

  {#if job}
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs leading-snug {phaseClass}">{phaseText}</span>
      {#if settled(job)}
        <button
          type="button"
          class="shrink-0 text-xs text-muted-foreground/70 transition hover:text-foreground"
          onclick={() => cliManager.dismiss(row.id)}
        >
          {t("cli.dismiss")}
        </button>
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
  <CliUninstallDialog
    {row}
    {label}
    onClose={() => (asking = false)}
    onConfirm={confirmRemoval}
  />
{/if}
