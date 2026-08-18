<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { scale } from "svelte/transition";
  import { workspace } from "$lib/backend";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { registerEscape, restoreFocus, viewportHeight } from "$lib/shared/keyboard/overlay";
  import { hasTauri } from "$lib/backend/env";
  import { device, type BoiteEntry } from "$lib/features/settings/device.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { portal } from "$lib/shared/actions/portal";
  import {
    switchToLocal,
    switchToBoite,
    connectAndInit,
    setActiveBoiteInfo,
    setDynamicMode,
    defaultRemoteWsUrl,
    refreshEnvironments,
  } from "$lib/app/workspace";
  import { environments } from "$lib/backend/environment/registry.svelte";
  import { isBehind } from "./version";
  import MobileSheet from "$lib/features/mobile/MobileSheet.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Radio from "@lucide/svelte/icons/radio";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import Monitor from "@lucide/svelte/icons/monitor";
  import Layers from "@lucide/svelte/icons/layers";

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
  const EDGE_GAP = 8;

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
  // What that boite is running. The live read wins for the one that is
  // connected; every other row shows what this device last saw, which is the
  // only answer available without dialling a server to draw a menu.
  function versionOf(b: BoiteEntry, active: boolean): string {
    return (active ? workspace.info.version || b.version : b.version) || "";
  }
  // Dynamic mode presents as the local side: the boite is grafted, not active.
  const onLocalSide = $derived(workspace.mode !== "remote");

  const activeColor = $derived(workspace.info.color || "var(--color-success)");
  const activeEntry = $derived(
    workspace.activeBoiteId ? device.getBoite(workspace.activeBoiteId) : null,
  );
  const boiteLabel = $derived(
    workspace.info.name ||
      hostOf(activeEntry?.url ?? workspace.remoteUrl ?? "") ||
      t("workspace.remote"),
  );
  const triggerLabel = $derived(
    workspace.mode === "remote" ? boiteLabel : t("workspace.local"),
  );
  // The pill dot shows any live boite link: the active remote workspace, or
  // the boite grafted into Local by dynamic mode.
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
    const x = Math.max(
      EDGE_GAP,
      Math.min(r.left + r.width / 2 - MENU_W / 2, vw - MENU_W - EDGE_GAP),
    );
    menuPos = { x, y: r.bottom + 6 };
  }

  // The panel is up to min(70vh, 34rem) tall, so on a short window the version
  // placed at `trigger.bottom + 6` ran off the bottom with no way to reach its
  // last rows. Measured rather than assumed: how tall it actually is depends on
  // how many boites are saved and whether the add form is showing.
  async function placeClamped() {
    place();
    await tick();
    if (!menuEl || !triggerRoot) return;
    const r = triggerRoot.getBoundingClientRect();
    // Layout box, not the painted one: the open transition scales the panel, and
    // a measurement taken mid-transition is shorter than what has to fit.
    const h = menuEl.offsetHeight;
    // The visual viewport, not innerHeight: an open soft keyboard leaves
    // innerHeight reporting room that is no longer on screen.
    const vh = viewportHeight();
    const below = r.bottom + 6;
    if (below + h + EDGE_GAP <= vh) return;
    // Above the trigger when it fits there, clamped to the top edge otherwise:
    // the panel scrolls, so the worst case is still reachable.
    const above = r.top - 6 - h;
    menuPos = { ...menuPos, y: Math.max(EDGE_GAP, above) };
  }

  $effect(() => {
    if (!open || mobile) return;
    void showAdd;
    void device.boites.length;
    void placeClamped();
  });

  $effect(() => {
    // The mobile sheet is a modal dialog and owns Escape itself.
    if (!open || mobile) return;
    return registerEscape(close);
  });

  $effect(() => {
    if (!open || mobile) return;
    const previous = document.activeElement as HTMLElement | null;
    const surface = menuEl;
    return () => restoreFocus(previous, surface);
  });

  // Swapping the list for the add form (and back) replaces every control in the
  // panel, so whatever was focused is gone and the keyboard would be left on
  // <body>, outside the trap below.
  $effect(() => {
    if (!open || mobile) return;
    void showAdd;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled || !open) return;
      if (menuEl?.contains(document.activeElement)) return;
      const primary = showAdd
        ? menuEl?.querySelector<HTMLInputElement>("input")
        : null;
      (primary ?? panelFocusables()[0] ?? menuEl)?.focus();
    });
    return () => {
      cancelled = true;
    };
  });

  function panelFocusables(): HTMLElement[] {
    return Array.from(
      menuEl?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled)",
      ) ?? [],
    );
  }

  function onPanelKeydown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    // Trapped: Tab used to walk out into the app and leave the panel floating
    // over a window the keyboard had already left.
    const all = panelFocusables();
    if (all.length === 0) return;
    const idx = all.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    if (idx < 0) {
      all[e.shiftKey ? all.length - 1 : 0].focus();
      return;
    }
    all[(idx + (e.shiftKey ? -1 : 1) + all.length) % all.length].focus();
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
    if (busy || workspace.mode !== "remote") {
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
  /**
   * Hold a connection to a boite this device is not standing on, or drop it.
   *
   * The menu is where it belongs rather than the settings panel: this is the
   * list of boites, and what the switch changes is whether one of them answers
   * without being switched to.
   */
  function toggleKeepConnected(entry: BoiteEntry) {
    device.setBoiteEnabled(entry.id, !entry.enabled);
    refreshEnvironments();
  }

  function environmentPhase(id: string): string {
    const runtime = environments.get(id);
    if (!runtime) return t("workspace.connStateDisconnected");
    if (runtime.phase === "connected") return t("workspace.connStateConnected");
    if (runtime.phase === "blocked") return t("workspace.connStateBlocked");
    return t("workspace.connStateConnecting");
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
  // Asked first: this drops the saved entry, its URL and its auth token, and the
  // token is the one thing here nobody can retype from memory.
  async function remove(entry: BoiteEntry) {
    const ok = await confirmDialog.ask({
      title: t("workspace.removeConfirmTitle"),
      message: t("workspace.removeConfirmMessage", { name: labelOf(entry) }),
      confirmLabel: t("workspace.removeConfirmAction"),
      danger: true,
    });
    // Through the registry, not `device.removeBoite` directly: the runtime
    // holds an authenticated socket that must close with the credential.
    if (ok) environments.remove(entry.id);
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
  async function toggleDynamic() {
    if (busy) return;
    busy = true;
    try {
      await setDynamicMode(!device.dynamicMode);
    } finally {
      busy = false;
    }
  }

  function onDocPointer(e: MouseEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (triggerRoot?.contains(t) || menuEl?.contains(t)) return;
    close();
  }
  const replace = () => void placeClamped();
  onMount(() => {
    document.addEventListener("mousedown", onDocPointer);
    window.addEventListener("resize", replace);
    // A soft keyboard shrinks the visual viewport without always resizing the
    // window, and this panel has two text fields that raise one.
    window.visualViewport?.addEventListener("resize", replace);
  });
  onDestroy(() => {
    document.removeEventListener("mousedown", onDocPointer);
    window.removeEventListener("resize", replace);
    window.visualViewport?.removeEventListener("resize", replace);
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
        <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("workspace.title")}
        </span>
      </div>
    {/if}

    {#if isTauri}
      <button
        type="button"
        class={`flex items-center gap-2.5 rounded-lg text-left transition hover:bg-accent disabled:opacity-50 ${mobile ? "px-3 py-3 text-sm" : "px-2.5 py-2 text-base"}`}
        onclick={pickLocal}
        disabled={busy}
      >
        <Monitor class="size-4 shrink-0 text-muted-foreground" />
        <span class="flex-1 font-medium text-foreground">{t("workspace.local")}</span>
        <!-- The build every row below is compared against, spelled out rather
             than left implicit: "behind" is only meaningful next to it. -->
        <span
          class="shrink-0 tabular-nums text-2xs text-muted-foreground"
          use:tip={t("workspace.versionThis")}
        >
          v{__APP_VERSION__}
        </span>
        {#if onLocalSide}
          <Check class="size-4 text-foreground" />
        {/if}
      </button>

      <!-- Dynamic mode: connecting to a boite merges its projects into the
           local list instead of replacing the workspace. Off = classic
           exclusive remote mode. -->
      <button
        type="button"
        role="switch"
        aria-checked={device.dynamicMode}
        class={`flex items-center gap-2.5 rounded-lg text-left transition hover:bg-accent disabled:opacity-50 ${mobile ? "px-3 py-3 text-sm" : "px-2.5 py-2 text-base"}`}
        onclick={toggleDynamic}
        disabled={busy}
        use:tip={t("workspace.dynamicTooltip")}
      >
        <Layers class="size-4 shrink-0 text-muted-foreground" />
        <span class="flex min-w-0 flex-1 flex-col leading-tight">
          <span class="font-medium text-foreground">{t("workspace.dynamicMode")}</span>
          <span class="truncate text-xs text-muted-foreground">
            {t("workspace.dynamicDesc")}
          </span>
        </span>
        <span
          class={`relative h-4 w-7 shrink-0 rounded-full transition ${device.dynamicMode ? "bg-foreground" : "bg-[var(--color-surface-3)]"}`}
        >
          <span
            class={`absolute top-0.5 size-3 rounded-full bg-background transition-all ${device.dynamicMode ? "left-3.5" : "left-0.5"}`}
          ></span>
        </span>
      </button>
    {/if}

    {#each device.boites as b (b.id)}
      {@const active = isActiveBoite(b.id)}
      {@const connected = active && workspace.connection === "connected"}
      {@const version = versionOf(b, active)}
      {@const behind = isBehind(version, __APP_VERSION__)}
      <div class="flex items-stretch gap-1">
        <button
          type="button"
          class={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left transition hover:bg-accent disabled:opacity-50 ${mobile ? "px-3 py-3 text-sm" : "px-2.5 py-2 text-base"}`}
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
            <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span class="truncate">{hostOf(b.url)}</span>
              <!-- A boite that is behind is worth seeing before switching to
                   it, so it is tinted rather than left as one number among
                   two. One this device has never reached says so instead of
                   showing a blank, which reads as "up to date". -->
              {#if version}
                <span
                  class={`shrink-0 tabular-nums text-2xs ${behind ? "rounded bg-warning/15 px-1 font-medium text-warning" : "text-muted-foreground/70"}`}
                  use:tip={behind
                    ? t("workspace.versionBehind", {
                        version,
                        local: __APP_VERSION__,
                      })
                    : t("workspace.versionSeen", { version })}
                >
                  v{version}
                </span>
              {:else}
                <span class="shrink-0 text-2xs text-muted-foreground/60">
                  {t("workspace.versionUnknown")}
                </span>
              {/if}
            </span>
          </span>
          {#if active}
            <span class="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground">
              {#if connected}
                {t("workspace.connStateConnected")}
              {:else if workspace.connection === "connecting"}
                {t("workspace.connStateConnecting")}
              {:else}
                {t("workspace.connStateDisconnected")}
              {/if}
            </span>
          {:else if b.enabled}
            <!-- The state of a connection this device holds without standing on
                 it, which is the only place that answers for one. -->
            <span class="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground">
              {environmentPhase(b.id)}
            </span>
          {/if}
        </button>
        {#if !active}
          <button
            type="button"
            class={`flex shrink-0 items-center justify-center rounded-lg transition hover:bg-accent ${mobile ? "w-11" : "w-9"} ${b.enabled ? "text-foreground" : "text-muted-foreground/50"}`}
            onclick={() => toggleKeepConnected(b)}
            aria-label={t("workspace.keepConnected")}
            use:tip={b.enabled
              ? t("workspace.keepConnectedOn")
              : t("workspace.keepConnectedOff")}
          >
            <Radio class="size-4" />
          </button>
          <button
            type="button"
            class={`flex shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-danger/20 hover:text-danger ${mobile ? "w-11" : "w-9"}`}
            onclick={() => void remove(b)}
            aria-label={t("workspace.removeBoite")}
            use:tip={t("shortcuts.remove")}
          >
            <Trash2 class="size-4" />
          </button>
        {/if}
      </div>

      {#if active}
        <div class="mb-1 flex flex-col gap-2.5 rounded-lg bg-[var(--color-background)] px-2.5 py-2.5">
          <label class="flex flex-col gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
            {t("workspace.name")}
            <input
              bind:value={nameDraft}
              placeholder={hostOf(b.url)}
              spellcheck="false"
              autocapitalize="off"
              onblur={commitName}
              onkeydown={(e) => e.key === "Enter" && commitName()}
              class={`w-full rounded-md border border-border bg-[var(--color-surface)] normal-case tracking-normal text-foreground outline-none focus:border-foreground/40 ${mobile ? "px-3 py-2.5 text-sm" : "px-2.5 py-1.5 text-base"}`}
            />
          </label>
          <div class="flex flex-col gap-1.5">
            <span class="text-2xs uppercase tracking-wide text-muted-foreground">
              {t("workspace.color")}
            </span>
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
                  aria-label={t("shortcuts.setColor", { color: c })}
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
              aria-label={t("workspace.backToList")}
            >
              <ArrowLeft class="size-4" />
            </button>
          {/if}
          <span class="text-base font-semibold text-foreground">{t("workspace.addServer")}</span>
        </div>

        <label class="flex flex-col gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
          {t("workspace.serverUrl")}
          <input
            bind:value={addUrl}
            placeholder="ws://host:7337/ws"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            class="w-full rounded-md border border-border bg-[var(--color-background)] px-3 py-2.5 font-mono text-sm normal-case tracking-normal text-foreground outline-none focus:border-foreground/40"
          />
        </label>
        <label class="flex flex-col gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
          {t("workspace.token")}
          <input
            bind:value={addToken}
            type="password"
            placeholder="••••••••"
            spellcheck="false"
            autocomplete="off"
            class="w-full rounded-md border border-border bg-[var(--color-background)] px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none focus:border-foreground/40"
          />
        </label>

        <div class="flex justify-end gap-2 pt-0.5">
          {#if device.boites.length > 0}
            <button
              type="button"
              class={`rounded-md text-muted-foreground transition hover:text-foreground ${mobile ? "px-3 py-2 text-sm" : "px-3 py-1.5 text-base"}`}
              onclick={() => (showAdd = false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
          {/if}
          <button
            type="button"
            class={`rounded-md bg-foreground font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50 ${mobile ? "px-4 py-2 text-sm" : "px-4 py-1.5 text-base"}`}
            onclick={submitAdd}
            disabled={busy || !addUrl.trim() || !addToken.trim()}
          >
            {busy ? t("workspace.connecting") : t("workspace.connect")}
          </button>
        </div>
      </div>
    {:else}
      {#if device.boites.length === 0 && !isTauri}
        <p class={`text-muted-foreground/70 ${mobile ? "px-3 py-2 text-sm" : "px-2.5 py-2 text-sm"}`}>
          {t("workspace.noServers")}
        </p>
      {/if}
      <button
        type="button"
        class={`mt-0.5 flex items-center gap-2.5 rounded-lg border border-dashed border-border text-left text-muted-foreground transition hover:border-foreground/30 hover:bg-accent hover:text-foreground ${mobile ? "px-3 py-3 text-sm" : "px-2.5 py-2 text-base"}`}
        onclick={openAdd}
      >
        <Plus class="size-4 shrink-0" />
        {t("workspace.addServerAction")}
      </button>
    {/if}
  </div>
{/snippet}

<div bind:this={triggerRoot} class="pointer-events-auto relative flex items-center">
  <button
    type="button"
    class="flex max-w-[40vw] items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface)] px-2 py-0.5 text-xs text-foreground transition hover:bg-[var(--color-surface-2)]"
    onclick={toggle}
    aria-haspopup="dialog"
    aria-expanded={open}
    use:tip={t("workspace.title")}
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
    <MobileSheet {open} title={t("workspace.title")} onClose={close}>
      {@render panel()}
    </MobileSheet>
  {:else if open}
    <!-- A dialog, not a menu: it holds a name field, a password field and a
         colour grid, none of which a screen reader can present as menu items. -->
    <div
      bind:this={menuEl}
      use:portal
      role="dialog"
      aria-label={t("workspace.title")}
      tabindex="-1"
      class="surface-popover fixed z-[var(--z-popover)] max-h-[min(70vh,34rem)] scroll-pane overflow-y-auto p-2"
      style:left="{menuPos.x}px"
      style:top="{menuPos.y}px"
      style:width="{MENU_W}px"
      style:transform-origin="top center"
      onkeydown={onPanelKeydown}
      transition:scale={{ duration: 100, start: 0.97 }}
    >
      {@render panel()}
    </div>
  {/if}
</div>
