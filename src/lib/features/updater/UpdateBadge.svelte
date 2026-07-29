<script lang="ts">
  import { updater } from "./store.svelte";
  import ArrowUpCircle from "@lucide/svelte/icons/arrow-up-circle";

  // Only surfaces once the payload is on disk. Anything earlier would offer a
  // restart that still has to wait on the network.
  const version = $derived(updater.readyVersion);
  const installing = $derived(updater.status.kind === "installing");
</script>

{#if version}
  <button
    type="button"
    class="flex h-7 items-center gap-1.5 rounded-md bg-foreground px-2 text-xs font-medium text-background transition hover:bg-foreground/90 disabled:opacity-60"
    onclick={() => updater.install()}
    disabled={installing}
    title="Boite {version} is ready — restart to apply"
    aria-label="Restart to update to Boite {version}"
  >
    <ArrowUpCircle class="size-3.5" />
    <span class="hidden sm:inline">{installing ? "Restarting…" : "Restart to update"}</span>
  </button>
{/if}
