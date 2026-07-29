<script lang="ts">
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import { updater } from "./store.svelte";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ArrowUpCircle from "@lucide/svelte/icons/arrow-up-circle";
  import { t } from "$lib/i18n/index.svelte";

  const status = $derived(updater.status);
  const progress = $derived(updater.progress);

  function mb(bytes: number): string {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
</script>

<SettingsCard
  title={t("updates.title")}
  description="New releases download in the background. Applying one only takes a restart."
>
  {#snippet actions()}
    {#if status.kind === "ready"}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition hover:bg-foreground/90"
        onclick={() => updater.install()}
      >
        <ArrowUpCircle class="size-3" />
        Restart now
      </button>
    {:else}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        onclick={() => updater.checkNow()}
        disabled={updater.busy || !updater.enabled}
      >
        <RefreshCw class="size-3 {updater.busy ? 'animate-spin' : ''}" />
        Check now
      </button>
    {/if}
  {/snippet}

  <div class="rounded-lg border border-border bg-[var(--color-surface-2)] px-3 py-2">
    <div class="flex items-baseline justify-between gap-3">
      <span class="text-xs text-foreground">Installed</span>
      <span class="font-mono text-xs text-muted-foreground">v{__APP_VERSION__}</span>
    </div>

    <p class="mt-1 text-sm leading-snug text-muted-foreground/80">
      {#if !updater.enabled}
        Updates are disabled in a development build.
      {:else if status.kind === "checking"}
        Checking for updates…
      {:else if status.kind === "current"}
        You are on the latest release.
      {:else if status.kind === "downloading"}
        Downloading {status.version}{status.total ? ` — ${mb(status.received)} of ${mb(status.total)}` : ""}
      {:else if status.kind === "ready"}
        Boite {status.version} is downloaded and ready.
      {:else if status.kind === "installing"}
        Applying the update…
      {:else if status.kind === "error"}
        <span class="text-danger">{status.message}</span>
      {:else}
        Boite checks for updates shortly after launch, then every few hours.
      {/if}
    </p>

    {#if status.kind === "downloading"}
      <div class="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
        <div
          class="h-full rounded-full bg-foreground transition-[width] duration-200 {progress ===
          null
            ? 'w-1/3 animate-pulse'
            : ''}"
          style={progress === null ? undefined : `width: ${(progress * 100).toFixed(1)}%`}
        ></div>
      </div>
    {/if}

    {#if status.kind === "ready" && status.notes}
      <pre
        class="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--color-surface-3)] p-2 font-mono text-xs leading-relaxed text-muted-foreground">{status.notes}</pre>
    {/if}
  </div>
</SettingsCard>
