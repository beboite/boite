<script lang="ts">
  import { workspace } from "$lib/backend";
  import { hasTauri } from "$lib/backend/env";
  import { device } from "$lib/features/settings/device.svelte";
  import { switchToRemote, switchToLocal } from "$lib/app/workspace";

  // No local backend in a browser/PWA: hide the Local pill, only Remote stands.
  const isTauri = hasTauri();
  let open = $state(false);
  let url = $state(device.state.remoteUrl);
  let token = $state(device.state.remoteToken);
  let busy = $state(false);

  const dotColor = $derived(
    workspace.mode === "local"
      ? null
      : workspace.connection === "connected"
        ? "var(--color-success)"
        : "var(--color-warning)",
  );

  async function goLocal() {
    if (workspace.mode === "local" || busy) return;
    busy = true;
    try {
      await switchToLocal();
    } finally {
      busy = false;
    }
  }

  async function goRemote() {
    if (busy) return;
    if (workspace.mode === "remote") {
      open = !open;
      return;
    }
    // Connect straight away when a target is saved; otherwise reveal the form.
    if (device.state.remoteUrl && device.state.remoteToken) {
      await connect();
      return;
    }
    open = !open;
  }

  async function connect() {
    if (busy) return;
    const u = url.trim();
    const t = token.trim();
    if (!u || !t) return;
    busy = true;
    device.setRemote(u, t);
    try {
      const ok = await switchToRemote(u, t);
      if (ok) open = false;
    } finally {
      busy = false;
    }
  }
</script>

<div class="pointer-events-auto relative flex items-center">
  <div class="flex items-center overflow-hidden rounded-md border border-border bg-[var(--color-surface)] text-[11px]">
    {#if isTauri}
      <button
        type="button"
        class="px-2 py-0.5 transition {workspace.mode === 'local'
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        onclick={goLocal}
        disabled={busy}
      >
        Local
      </button>
    {/if}
    <button
      type="button"
      class="flex items-center gap-1 px-2 py-0.5 transition {workspace.mode === 'remote'
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:text-foreground'}"
      onclick={goRemote}
      disabled={busy}
      title={workspace.remoteUrl ?? "Connect to a remote workspace"}
    >
      {#if dotColor}
        <span
          class="size-1.5 rounded-full"
          class:animate-pulse={workspace.connection !== "connected"}
          style:background-color={dotColor}
        ></span>
      {/if}
      Remote
    </button>
  </div>

  {#if open}
    <div
      class="absolute left-1/2 top-[calc(100%+6px)] z-50 w-64 -translate-x-1/2 rounded-md border border-border bg-[var(--color-surface)] p-2.5 shadow-xl"
    >
      <p class="mb-1.5 text-[11px] font-medium text-foreground">Remote workspace</p>
      <label class="mb-1.5 block">
        <span class="mb-0.5 block text-[10px] text-muted-foreground">WebSocket URL</span>
        <input
          bind:value={url}
          placeholder="ws://host:7337/ws"
          spellcheck="false"
          autocapitalize="off"
          class="w-full rounded border border-border bg-[var(--color-background)] px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-foreground/40"
        />
      </label>
      <label class="mb-2 block">
        <span class="mb-0.5 block text-[10px] text-muted-foreground">Token</span>
        <input
          bind:value={token}
          type="password"
          spellcheck="false"
          class="w-full rounded border border-border bg-[var(--color-background)] px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-foreground/40"
        />
      </label>
      <div class="flex justify-end gap-1.5">
        <button
          type="button"
          class="rounded px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
          onclick={() => (open = false)}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded bg-foreground px-2.5 py-1 text-[11px] font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50"
          onclick={connect}
          disabled={busy || !url.trim() || !token.trim()}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </div>
  {/if}
</div>
