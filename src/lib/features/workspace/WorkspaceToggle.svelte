<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { scale } from "svelte/transition";
  import { workspace } from "$lib/backend";
  import { hasTauri } from "$lib/backend/env";
  import { device, type BoiteEntry } from "$lib/features/settings/device.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { portal } from "$lib/shared/actions/portal";
  import {
    switchToLocal,
    switchToBoite,
    connectAndInit,
    setActiveBoiteInfo,
    defaultRemoteWsUrl,
  } from "$lib/app/workspace";
  import MobileSheet from "$lib/features/mobile/MobileSheet.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Monitor from "@lucide/svelte/icons/monitor";

  // No local backend in a browser/PWA: only saved boites stand.
  const isTauri = hasTauri();
  const mobile = $derived(settings.state.mobileLayout);

  // Differentiation palette for the connection outline. Free-form hex is
  // allowed (the server validates), but these cover the picker.
  const PALETTE = [
    "#4ade80",
    "#22d3ee",
    "#60a5fa",
    "#a855f7",
    "#f472b6",
    "#f87171",
    "#fb923c",
    "#facc15",
  ];

  const MENU_W = 340;

  let open = $state(false);
  let showAdd = $state(false);
  let addUrl = $state("");
  let addToken = $state("");
  let busy = $state(false);
  let nameDraft = $state("");
  let menuPos = $state({ x: 0, y: 0 });
  let triggerRoot: HTMLDivElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);

  function hostOf(url: string): string {
    if (!url) return "";
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  function labelOf(b: BoiteEntry): string {
    return b.name || hostOf(b.url) || "boite";
  }
  function isActiveBoite(id: string): boolean {
    return workspace.mode === "remote" && workspace.activeBoiteId === id;
  }

  const activeColor = $derived(workspace.info.color || "var(--color-success)");
  const activeEntry = $derived(
    workspace.activeBoiteId ? device.getBoite(workspace.activeBoiteId) : null,
  );
  const triggerLabel = $derived(
    workspace.mode === "local"
      ? "Local"
      : workspace.info.name ||
          hostOf(activeEntry?.url ?? workspace.remoteUrl ?? "") ||
          "Remote",
  );
  const triggerDot = $derived(
    workspace.mode === "local"
      ? null
      : workspace.connection === "connected"
        ? activeColor
        : "var(--color-warning)",
  );

  // The titlebar centers this toggle with a CSS transform, which becomes the
  // containing block for any `position: fixed` child. The menu is portaled to
  // <body> to escape that (and the titlebar's stacking context, which paints
  // below the main content / shortcut bar); position it from the trigger rect.
  function place() {
    if (!triggerRoot) return;
    const r = triggerRoot.getBoundingClientRect();
    const vw = window.innerWidth;
    const x = Math.max(8, Math.min(r.left + r.width / 2 - MENU_W / 2, vw - MENU_W - 8));
    menuPos = { x, y: r.bottom + 6 };
  }

  function toggle() {
    if (open) {
      close();
      return;
    }
    nameDraft = workspace.info.name ?? "";
    // Always land on the list (Local + saved boites). Adding a server is an
    // explicit step, not the default screen.
    showAdd = false;
    place();
    open = true;
  }
  function close() {
    open = false;
    showAdd = false;
  }
  function openAdd() {
    // In a PWA the serving origin is the obvious default; on desktop the
    // internal Tauri host is useless, so leave it to the placeholder.
    if (!isTauri && !addUrl) addUrl = defaultRemoteWsUrl();
    showAdd = true;
  }

  async function pickLocal() {
    if (busy || workspace.mode === "local") {
      close();
      return;
    }
    busy = true;
    try {
      await switchToLocal();
    } finally {
      busy = false;
      close();
    }
  }
  async function pickBoite(id: string) {
    if (busy) return;
    busy = true;
    try {
      await switchToBoite(id);
    } finally {
      busy = false;
      close();
    }
  }
  async function submitAdd() {
    const u = addUrl.trim();
    const t = addToken.trim();
    if (!u || !t || busy) return;
    busy = true;
    try {
      const ok = await connectAndInit(u, t);
      if (ok) {
        addUrl = "";
        addToken = "";
        close();
      }
    } finally {
      busy = false;
    }
  }
  function remove(id: string) {
    device.removeBoite(id);
  }
  async function commitName() {
    const name = nameDraft.trim();
    if ((workspace.info.name ?? "") === name) return;
    await setActiveBoiteInfo({ name: name || null });
  }
  async function pickColor(c: string) {
    if ((workspace.info.color ?? "") === c) return;
    await setActiveBoiteInfo({ color: c });
  }

  function onDocPointer(e: MouseEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (triggerRoot?.contains(t) || menuEl?.contains(t)) return;
    close();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) close();
  }
  onMount(() => {
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
  });
  onDestroy(() => {
    document.removeEventListener("mousedown", onDocPointer);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", place);
  });
</script>

{#snippet rowDot(color: string, lit: boolean, pulse: boolean)}
  <span
    class="size-2.5 shrink-0 rounded-full"
    class:animate-pulse={pulse}
    style:background-color={color}
    style:opacity={lit ? "1" : "0.4"}
  ></span>
{/snippet}

{#snippet panel()}
  <div class="flex flex-col gap-1">
    {#if !mobile}
      <div class="px-2 pb-1 pt-0.5">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Workspaces
        </span>
      </div>
    {/if}

    {#if isTauri}
      <button
        type="button"
        class={`flex items-center gap-2.5 rounded-lg text-left transition hover:bg-accent disabled:opacity-50 ${mobile ? "px-3 py-3 text-sm" : "px-2.5 py-2 text-[13px]"}`}
        onclick={pickLocal}
        disabled={busy}
      >
        <Monitor class="size-4 shrink-0 text-muted-foreground" />
        <span class="flex-1 font-medium text-foreground">Local</span>
        {#if workspace.mode === "local"}
          <Check class="size-4 text-foreground" />
        {/if}
      </button>
    {/if}

    {#each device.boites as b (b.id)}
      {@const active = isActiveBoite(b.id)}
      {@const connected = active && workspace.connection === "connected"}
      <div class="flex items-stretch gap-1">
        <button
          type="button"
          class={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left transition hover:bg-accent disabled:opacity-50 ${mobile ? "px-3 py-3 text-sm" : "px-2.5 py-2 text-[13px]"}`}
          onclick={() => pickBoite(b.id)}
          disabled={busy}
        >
          {@render rowDot(
            active ? activeColor : b.color || "var(--color-muted-foreground)",
            active,
            active && !connected,
          )}
          <span class="flex min-w-0 flex-1 flex-col leading-tight">
            <span class="truncate font-medium text-foreground">{labelOf(b)}</span>
            <span class="truncate text-[11px] text-muted-foreground">{hostOf(b.url)}</span>
          </span>
          {#if active}
            <span class="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              {connected ? "connected" : workspace.connection}
            </span>
          {/if}
        </button>
        {#if !active}
          <button
            type="button"
            class={`flex shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-danger/20 hover:text-danger ${mobile ? "w-11" : "w-9"}`}
            onclick={() => remove(b.id)}
            aria-label="Remove boite"
            title="Remove"
          >
            <Trash2 class="size-4" />
          </button>
        {/if}
      </div>

      {#if active}
        <div class="mb-1 flex flex-col gap-2.5 rounded-lg bg-[var(--color-background)] px-2.5 py-2.5">
          <label class="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Name
            <input
              bind:value={nameDraft}
              placeholder={hostOf(b.url)}
              spellcheck="false"
              autocapitalize="off"
              onblur={commitName}
              onkeydown={(e) => e.key === "Enter" && commitName()}
              class={`w-full rounded-md border border-border bg-[var(--color-surface)] normal-case tracking-normal text-foreground outline-none focus:border-foreground/40 ${mobile ? "px-3 py-2.5 text-sm" : "px-2.5 py-1.5 text-[13px]"}`}
            />
          </label>
          <div class="flex flex-col gap-1.5">
            <span class="text-[10px] uppercase tracking-wide text-muted-foreground">Color</span>
            <div class={`flex flex-wrap ${mobile ? "gap-2.5" : "gap-2"}`}>
              {#each PALETTE as c (c)}
                <button
                  type="button"
                  class={`shrink-0 rounded-full border-2 transition hover:scale-110 ${mobile ? "size-9" : "size-6"}`}
                  style:background-color={c}
                  style:border-color={(workspace.info.color ?? "") === c
                    ? "var(--color-foreground)"
                    : "transparent"}
                  onclick={() => pickColor(c)}
                  aria-label="Set color"
                ></button>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    {/each}

    {#if showAdd}
      <div class="mt-1 flex flex-col gap-3 border-t border-border px-1 pb-1 pt-3">
        <div class="flex items-center gap-2">
          {#if device.boites.length > 0}
            <button
              type="button"
              class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onclick={() => (showAdd = false)}
              aria-label="Back to list"
            >
              <ArrowLeft class="size-4" />
            </button>
          {/if}
          <span class="text-[13px] font-semibold text-foreground">Add a boite server</span>
        </div>

        <label class="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Server URL
          <input
            bind:value={addUrl}
            placeholder="ws://host:7337/ws"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            class="w-full rounded-md border border-border bg-[var(--color-background)] px-3 py-2.5 font-mono text-sm normal-case tracking-normal text-foreground outline-none focus:border-foreground/40"
          />
        </label>
        <label class="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Token
          <input
            bind:value={addToken}
            type="password"
            placeholder="••••••••"
            spellcheck="false"
            autocomplete="off"
            class="w-full rounded-md border border-border bg-[var(--color-background)] px-3 py-2.5 font-mono text-sm normal-case tracking-normal text-foreground outline-none focus:border-foreground/40"
          />
        </label>

        <div class="flex justify-end gap-2 pt-0.5">
          {#if device.boites.length > 0}
            <button
              type="button"
              class={`rounded-md text-muted-foreground transition hover:text-foreground ${mobile ? "px-3 py-2 text-sm" : "px-3 py-1.5 text-[13px]"}`}
              onclick={() => (showAdd = false)}
              disabled={busy}
            >
              Cancel
            </button>
          {/if}
          <button
            type="button"
            class={`rounded-md bg-foreground font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50 ${mobile ? "px-4 py-2 text-sm" : "px-4 py-1.5 text-[13px]"}`}
            onclick={submitAdd}
            disabled={busy || !addUrl.trim() || !addToken.trim()}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    {:else}
      {#if device.boites.length === 0 && !isTauri}
        <p class={`text-muted-foreground/70 ${mobile ? "px-3 py-2 text-sm" : "px-2.5 py-2 text-[12px]"}`}>
          No boite server yet.
        </p>
      {/if}
      <button
        type="button"
        class={`mt-0.5 flex items-center gap-2.5 rounded-lg border border-dashed border-border text-left text-muted-foreground transition hover:border-foreground/30 hover:bg-accent hover:text-foreground ${mobile ? "px-3 py-3 text-sm" : "px-2.5 py-2 text-[13px]"}`}
        onclick={openAdd}
      >
        <Plus class="size-4 shrink-0" />
        Add boite server
      </button>
    {/if}
  </div>
{/snippet}

<div bind:this={triggerRoot} class="pointer-events-auto relative flex items-center">
  <button
    type="button"
    class="flex max-w-[40vw] items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface)] px-2 py-0.5 text-[11px] text-foreground transition hover:bg-[var(--color-surface-2)]"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    title="Workspaces"
  >
    {#if triggerDot}
      <span
        class="size-1.5 shrink-0 rounded-full"
        class:animate-pulse={workspace.connection !== "connected"}
        style:background-color={triggerDot}
      ></span>
    {/if}
    <span class="truncate">{triggerLabel}</span>
    <ChevronDown class="size-3 shrink-0 text-muted-foreground" />
  </button>

  {#if mobile}
    <MobileSheet {open} title="Workspaces" onClose={close}>
      {@render panel()}
    </MobileSheet>
  {:else if open}
    <div
      bind:this={menuEl}
      use:portal
      role="menu"
      class="fixed z-[9999] max-h-[min(70vh,34rem)] overflow-y-auto rounded-xl border border-border bg-[var(--color-surface)] p-2 shadow-2xl"
      style:left="{menuPos.x}px"
      style:top="{menuPos.y}px"
      style:width="{MENU_W}px"
      style:transform-origin="top center"
      transition:scale={{ duration: 100, start: 0.97 }}
    >
      {@render panel()}
    </div>
  {/if}
</div>
