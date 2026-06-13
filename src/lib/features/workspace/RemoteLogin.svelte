<script lang="ts">
  import { connectAndInit, defaultRemoteWsUrl } from "$lib/app/workspace";
  import { device } from "$lib/features/settings/device.svelte";
  import BoiteLogo from "$lib/shared/components/BoiteLogo.svelte";

  // PWA / browser entry: there is no local backend, so the app gates here
  // until it can reach a boite-server. URL defaults to the serving origin.
  let url = $state(device.state.remoteUrl || defaultRemoteWsUrl());
  let token = $state(device.state.remoteToken || "");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || !token.trim()) return;
    error = null;
    busy = true;
    const ok = await connectAndInit(url.trim(), token.trim());
    busy = false;
    if (!ok) error = "Connection failed. Check the URL and token.";
  }
</script>

<div class="flex h-full w-full items-center justify-center bg-[var(--color-background)] p-6">
  <form onsubmit={submit} class="flex w-full max-w-sm flex-col gap-4">
    <div class="mb-2 flex flex-col items-center gap-3">
      <span class="text-muted-foreground/60"><BoiteLogo size={48} /></span>
      <h1 class="text-sm text-muted-foreground">Connect to a boite server</h1>
    </div>

    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      Server URL
      <input
        class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-[var(--color-success)]"
        bind:value={url}
        placeholder="wss://host/ws"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </label>

    <label class="flex flex-col gap-1 text-xs text-muted-foreground">
      Token
      <input
        class="rounded-md border border-border bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-[var(--color-success)]"
        type="password"
        bind:value={token}
        autocomplete="off"
      />
    </label>

    {#if error}
      <p class="text-xs text-danger">{error}</p>
    {/if}

    <button
      type="submit"
      disabled={busy || !token.trim()}
      class="rounded-md border border-border bg-[var(--color-surface-2)] px-3 py-2 text-sm text-foreground transition hover:bg-[var(--color-surface-3)] disabled:opacity-50"
    >
      {busy ? "Connecting…" : "Connect"}
    </button>
  </form>
</div>
