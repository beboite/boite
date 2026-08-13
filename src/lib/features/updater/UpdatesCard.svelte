<script lang="ts">
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import { updater } from "./store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ArrowUpCircle from "@lucide/svelte/icons/arrow-up-circle";

  const status = $derived(updater.status);
  const progress = $derived(updater.progress);

  function mb(bytes: number): string {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }

  /**
   * What a screen reader hears, which is not what the line above shows.
   *
   * The visible text counts megabytes and changes with every chunk that lands;
   * a polite region carrying it would be read aloud dozens of times per
   * download. This one moves in tenths, so the start, the progress and the end
   * are each announced once.
   */
  const announcement = $derived.by(() => {
    if (!updater.enabled) return t("updater.devBuild");
    switch (status.kind) {
      case "checking":
        return t("updater.checking");
      case "current":
        return t("updater.upToDate");
      case "downloading": {
        const line = t("updater.downloading", { version: status.version });
        return progress === null ? line : `${line} ${Math.floor(progress * 10) * 10}%`;
      }
      case "ready":
        return t("updater.readyLine", { version: status.version });
      case "installing":
        return t("updater.installing");
      case "error":
        return status.message;
      default:
        return "";
    }
  });
</script>

<SettingsCard
  title={t("updater.title")}
  description={t("updater.description")}
>
  {#snippet actions()}
    {#if status.kind === "ready"}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition hover:bg-foreground/90"
        onclick={() => void updater.install()}
      >
        <ArrowUpCircle class="size-3" />
        {t("updater.restartNow")}
      </button>
    {:else}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        onclick={() => updater.checkNow()}
        disabled={updater.busy || !updater.enabled}
      >
        <RefreshCw class="size-3 {updater.busy ? 'animate-spin' : ''}" />
        {t("updater.checkNow")}
      </button>
    {/if}
  {/snippet}

  <div class="rounded-lg border border-border bg-[var(--color-surface-2)] px-3 py-2">
    <div class="flex items-baseline justify-between gap-3">
      <span class="text-xs text-foreground">{t("updater.installed")}</span>
      <span class="tabular-nums text-xs text-muted-foreground">v{__APP_VERSION__}</span>
    </div>

    <p class="mt-1 text-sm leading-snug text-muted-foreground/80">
      {#if !updater.enabled}
        {t("updater.devBuild")}
      {:else if status.kind === "checking"}
        {t("updater.checking")}
      {:else if status.kind === "current"}
        {t("updater.upToDate")}
      {:else if status.kind === "downloading"}
        {status.total
          ? t("updater.downloadingProgress", {
              version: status.version,
              received: mb(status.received),
              total: mb(status.total),
            })
          : t("updater.downloading", { version: status.version })}
      {:else if status.kind === "ready"}
        {t("updater.readyLine", { version: status.version })}
      {:else if status.kind === "installing"}
        {t("updater.installing")}
      {:else if status.kind === "error"}
        <!-- The provider's own message, surfaced as it came. -->
        <span class="text-danger">{status.message}</span>
      {:else}
        {t("updater.idleHint")}
      {/if}
    </p>

    {#if status.kind === "downloading"}
      <!-- aria-valuenow is left off while the server withheld a content length:
           its absence is how ARIA spells indeterminate, and a number there would
           claim progress nobody can compute. aria-valuetext then carries the one
           thing that is known, which is that bytes are arriving. -->
      <div
        class="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]"
        role="progressbar"
        aria-label={t("updater.downloading", { version: status.version })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress === null ? undefined : Math.round(progress * 100)}
        aria-valuetext={progress === null
          ? t("updater.downloading", { version: status.version })
          : undefined}
      >
        <div
          class="h-full rounded-full bg-foreground transition-[width] duration-200 {progress ===
          null
            ? 'w-1/3 animate-pulse'
            : ''}"
          style={progress === null ? undefined : `width: ${(progress * 100).toFixed(1)}%`}
        ></div>
      </div>
    {/if}

    <p class="sr-only" role="status" aria-live="polite">{announcement}</p>

    {#if status.kind === "ready" && status.notes}
      <pre
        class="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--color-surface-3)] p-2 text-xs leading-relaxed text-muted-foreground">{status.notes}</pre>
    {/if}
  </div>
</SettingsCard>
