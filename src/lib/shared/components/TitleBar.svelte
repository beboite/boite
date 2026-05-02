<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { app } from "$lib/app/store.svelte";
  import Minus from "@lucide/svelte/icons/minus";
  import Square from "@lucide/svelte/icons/square";
  import Copy from "@lucide/svelte/icons/copy";
  import X from "@lucide/svelte/icons/x";
  import Settings from "@lucide/svelte/icons/settings";
  import TerminalIcon from "@lucide/svelte/icons/terminal";

  type Props = { title?: string };
  let { title = "Boite" }: Props = $props();

  const win = getCurrentWindow();
  let isMaximized = $state(false);

  async function syncMaximized() {
    try {
      isMaximized = await win.isMaximized();
    } catch {
      isMaximized = false;
    }
  }

  onMount(() => {
    void syncMaximized();
    const unlisten = win.onResized(() => {
      void syncMaximized();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  });

  function minimize() {
    void win.minimize();
  }
  function toggleMax() {
    void win.toggleMaximize().then(() => syncMaximized());
  }
  function close() {
    void win.close();
  }

  function showSettings() {
    app.view = "settings";
  }
  function showTerminal() {
    app.view = "terminal";
  }
</script>

<div
  data-tauri-drag-region
  class="relative flex h-10 shrink-0 select-none items-center border-b border-border bg-[var(--color-titlebar)]"
>
  <div class="flex items-center gap-1 pl-2">
    <button
      type="button"
      class="flex h-7 items-center justify-center rounded-md px-2 transition {app.view ===
      'terminal'
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
      onclick={showTerminal}
      title="Terminal"
      aria-label="Terminal"
    >
      <TerminalIcon class="size-3.5" />
    </button>
    <button
      type="button"
      class="flex h-7 items-center justify-center rounded-md px-2 transition {app.view ===
      'settings'
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
      onclick={showSettings}
      title="Settings"
      aria-label="Settings"
    >
      <Settings class="size-3.5" />
    </button>
    <span class="ml-1 text-[10px] text-muted-foreground/70">
      {app.threads.length} thread{app.threads.length === 1 ? "" : "s"} in
      {app.projects.length} project{app.projects.length === 1 ? "" : "s"}
    </span>
  </div>

  <div
    data-tauri-drag-region
    class="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[13px] font-semibold tracking-tight text-foreground/90"
  >
    {title}
  </div>

  <div data-tauri-drag-region class="flex-1"></div>

  <div class="flex h-full items-stretch">
    <button
      type="button"
      class="flex h-full w-11 items-center justify-center text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
      onclick={minimize}
      aria-label="Minimize"
      title="Minimize"
    >
      <Minus class="size-3.5" />
    </button>
    <button
      type="button"
      class="flex h-full w-11 items-center justify-center text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
      onclick={toggleMax}
      aria-label={isMaximized ? "Restore" : "Maximize"}
      title={isMaximized ? "Restore" : "Maximize"}
    >
      {#if isMaximized}
        <Copy class="size-3" />
      {:else}
        <Square class="size-3" />
      {/if}
    </button>
    <button
      type="button"
      class="flex h-full w-11 items-center justify-center text-muted-foreground transition hover:bg-danger hover:text-white"
      onclick={close}
      aria-label="Close"
      title="Close"
    >
      <X class="size-3.5" />
    </button>
  </div>
</div>
