<script lang="ts">
  import { onMount } from "svelte";
  import { fastpick } from "$lib/features/fastpick/store.svelte";
  import { installer } from "$lib/features/fastpick/installer.svelte";
  import {
    FASTPICK_REPO,
    installCommand,
    uninstallCommand,
    updateCommand,
  } from "$lib/features/fastpick/install";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Download from "@lucide/svelte/icons/download";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Square from "@lucide/svelte/icons/square";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";

  let { anchor }: { anchor: MessageKey } = $props();

  const installed = $derived(fastpick.installed === true);
  const cargoMissing = $derived(fastpick.cargoPresent === false);
  const install = installCommand();
  const update = updateCommand();
  const uninstall = uninstallCommand();

  // Only the first install compiles. Updating is fastpick fetching its own signed
  // release, so a machine without a toolchain can still take one.
  const primary = $derived(installed ? update : install);

  function line(c: { cmd: string; args: string[] }): string {
    return [c.cmd, ...c.args].join(" ");
  }

  /** What the run has to say about itself, or null while it has said nothing. */
  const verdict = $derived.by(() => {
    switch (installer.status) {
      case "running":
        switch (installer.action) {
          case "uninstall":
            return t("fastpick.runningUninstall");
          case "update":
            return t("fastpick.runningUpdate");
          default:
            return t("fastpick.runningInstall");
        }
      case "done":
        return t("fastpick.finished");
      case "cancelled":
        return t("fastpick.cancelled");
      case "failed": {
        // The command that failed, not the one the button offers now: a failed
        // update leaves `installed` true and its own name is what the log holds.
        const cmd = installer.action === "update" ? update.cmd : install.cmd;
        return installer.failure
          ? t("fastpick.failedToStart", { cmd, error: installer.failure })
          : t("fastpick.failedWithCode", { cmd, code: installer.exitCode ?? "?" });
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

  // The build writes to the bottom, which is the only end anyone reads. Pinned
  // rather than followed: a user who has scrolled up is reading something, and
  // yanking them back down every 120ms would make the log unreadable exactly
  // when it matters.
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
    notifications.success(t("fastpick.logCopied"));
  }

  onMount(() => {
    void fastpick.probe();
  });
</script>

<SettingsCard title={t("fastpick.settingsTitle")} {anchor} description={t("fastpick.settingsDesc")}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
      onclick={() => fastpick.probe()}
      disabled={fastpick.probing}
      title={t("fastpick.recheck")}
    >
      <RefreshCw class="size-3 {fastpick.probing ? 'animate-spin' : ''}" />
      {t("fastpick.recheck")}
    </button>
  {/snippet}

  <div class="flex items-center gap-2 text-xs">
    <span
      class="size-1.5 shrink-0 rounded-full"
      style:background-color={installed ? "var(--color-success)" : "var(--color-border)"}
    ></span>
    {#if fastpick.probing && fastpick.installed === null}
      <span class="text-muted-foreground">{t("common.loading")}</span>
    {:else if installed}
      <span class="text-foreground">{t("fastpick.installed")}</span>
      {#if fastpick.version}
        <span class="tabular-nums text-xs text-muted-foreground/70">v{fastpick.version}</span>
      {/if}
    {:else}
      <span class="text-muted-foreground">{t("fastpick.notInstalled")}</span>
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
      {installed ? t("fastpick.update") : t("fastpick.install")}
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
        {t("fastpick.uninstall")}
      </button>
    {/if}
    {#if installer.busy}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
        onclick={() => installer.cancel()}
      >
        <Square class="size-3" />
        {t("fastpick.stop")}
      </button>
    {:else if installer.status === "failed" || installer.status === "cancelled"}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition hover:border-foreground/30"
        onclick={() => installer.retry()}
      >
        <RotateCw class="size-3" />
        {t("fastpick.retry")}
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
            {t("fastpick.copyLog")}
          </button>
          <button
            type="button"
            class="text-xs text-muted-foreground/70 transition hover:text-foreground"
            onclick={() => installer.dismiss()}
          >
            {t("fastpick.clearLog")}
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
      <!-- Unkeyed on purpose. The tail rolls, so every line's content changes
           under a fixed position: keying on the text would rebuild the whole
           box on each repaint, and there is no id to key on that does not. -->
      {#each installer.lines as text}
        <div class="break-words whitespace-pre-wrap text-foreground/80">{text}</div>
      {/each}
    </div>
  {/if}

  <!-- No thread any more: the build is minutes of compiler output, and a panel
       that can show it is a panel that can also say whether it worked. -->
  <p class="pt-1 text-xs leading-snug text-muted-foreground/80">
    {t("fastpick.runsHere")}
  </p>
  <p class="text-xs leading-snug text-muted-foreground/80">
    {t("fastpick.keepsConfig")}
  </p>
  <!-- Only the first install and the uninstall are cargo's. Saying a toolchain is
       missing next to an Update button that does not want one reads as a blocker. -->
  {#if cargoMissing && !installed}
    <p class="text-xs leading-snug text-[var(--color-warning)]">
      {t("fastpick.needsCargo")}
      {t("fastpick.needsCargoHelp")}
    </p>
  {/if}
  <p class="pt-0.5 text-xs text-muted-foreground/60">{FASTPICK_REPO}</p>
</SettingsCard>
