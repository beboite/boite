<!--
  The half of a plugin card that is the same for every plugin: whether the
  binary is here, install/update/uninstall, the build log and what it exited
  with. What a given plugin can do once installed goes in the `children`
  snippet, which is the only part any of them disagree about.
-->
<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Download from "@lucide/svelte/icons/download";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Square from "@lucide/svelte/icons/square";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import type { PluginInstallDriver } from "./installer.svelte";
  import type { PluginProbe } from "./spec";

  let {
    anchor,
    title,
    description,
    repo,
    install,
    update,
    uninstall,
    probe,
    installer,
    runningUpdateKey = "plugin.runningUpdate",
    children,
  }: {
    anchor: MessageKey;
    title: string;
    description: string;
    /** Where it is published, printed as the last line of the card. */
    repo: string;
    install: { cmd: string; args: string[] };
    update: { cmd: string; args: string[] };
    uninstall: { cmd: string; args: string[] };
    probe: PluginProbe;
    installer: PluginInstallDriver;
    /** fastpick's update is a signed fetch, not a cargo rebuild. */
    runningUpdateKey?: MessageKey;
    /** What this plugin offers once it is installed, if anything. */
    children?: Snippet;
  } = $props();

  const installed = $derived(probe.installed === true);
  const cargoMissing = $derived(probe.cargoPresent === false);
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
            return t(runningUpdateKey);
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

  onMount(() => {
    void probe.probe();
  });
</script>

<SettingsCard {title} {anchor} {description}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      onclick={() => probe.probe()}
      disabled={probe.probing || installer.busy}
      use:tip={t("plugin.recheck")}
    >
      <RefreshCw class="size-3 {probe.probing ? 'animate-spin' : ''}" />
      {t("plugin.recheck")}
    </button>
  {/snippet}

  <div class="flex items-center gap-2 text-xs">
    <span
      class="size-1.5 shrink-0 rounded-full"
      style:background-color={installed ? "var(--color-success)" : "var(--color-border)"}
    ></span>
    {#if probe.probing && probe.installed === null}
      <span class="text-muted-foreground">{t("common.loading")}</span>
    {:else if installed}
      <span class="text-foreground">{t("plugin.installed")}</span>
      {#if probe.version}
        <span class="tabular-nums text-xs text-muted-2">v{probe.version}</span>
      {/if}
    {:else}
      <span class="text-muted-foreground">{t("plugin.notInstalled")}</span>
    {/if}
  </div>

  <div class="flex flex-wrap items-center gap-1.5 pt-1">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-40"
      onclick={() => (installed ? installer.update() : installer.install())}
      disabled={installer.busy || (primary.cmd === "cargo" && cargoMissing)}
      use:tip={line(primary)}
    >
      <Download class="size-3" />
      {installed ? t("plugin.update") : t("plugin.install")}
    </button>
    {#if installed}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-edge bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-40"
        onclick={() => installer.uninstall()}
        disabled={installer.busy || (uninstall.cmd === "cargo" && cargoMissing)}
        use:tip={line(uninstall)}
      >
        <Trash2 class="size-3" />
        {t("plugin.uninstall")}
      </button>
    {/if}
    {#if installer.busy}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
        onclick={() => installer.cancel()}
      >
        <Square class="size-3" />
        {t("plugin.stop")}
      </button>
    {:else if installer.status === "failed" || installer.status === "cancelled"}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30"
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
            class="flex items-center gap-1 text-xs text-muted-2 transition hover:text-foreground"
            onclick={copyLog}
          >
            <Copy class="size-3" />
            {t("plugin.copyLog")}
          </button>
          <button
            type="button"
            class="text-xs text-muted-2 transition hover:text-foreground"
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
      class="max-h-52 min-h-24 scroll-pane overflow-y-auto rounded-md border border-border bg-[var(--color-titlebar)] p-2 font-mono text-xs leading-snug"
    >
      {#each installer.lines as text}
        <div class="break-words whitespace-pre-wrap text-foreground">{text}</div>
      {/each}
    </div>
  {/if}

  {#if cargoMissing && !installed && install.cmd === "cargo"}
    <p class="text-xs leading-snug text-[var(--color-warning)]">
      {t("plugin.needsCargo")}
    </p>
  {/if}

  {#if probe.error}
    <p class="text-xs leading-snug text-[var(--color-danger)]">{probe.error}</p>
  {/if}

  {@render children?.()}

  <p class="pt-0.5 text-xs text-muted-2">{repo}</p>
</SettingsCard>
