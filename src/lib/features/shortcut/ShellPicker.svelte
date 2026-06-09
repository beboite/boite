<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { scale } from "svelte/transition";
  import { app } from "$lib/app/store.svelte";
  import { platform } from "$lib/storage/platform.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { launchShell, launchBlankTerminal } from "$lib/features/thread/api";
  import type { ShellOption } from "$lib/storage/platform.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  let open = $state(false);
  let triggerRoot: HTMLDivElement | null = $state(null);
  let menu: HTMLDivElement | null = $state(null);
  let menuPos = $state({ x: 0, y: 0 });

  const defaultShell = $derived(
    settings.state.defaultShellId
      ? platform.shells.find((s) => s.id === settings.state.defaultShellId) ?? null
      : null,
  );

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (!open && triggerRoot) {
      // Fixed positioning: the shortcut bar is overflow-x-auto, which clips
      // (or scrolls) an absolutely-positioned dropdown inside it.
      const r = triggerRoot.getBoundingClientRect();
      menuPos = { x: r.left, y: r.bottom + 4 };
    }
    open = !open;
  }

  async function launchDefault() {
    open = false;
    const projectId = app.currentProjectId;
    if (!projectId) return;
    if (defaultShell) {
      await launchShell(defaultShell, projectId);
    } else {
      await launchBlankTerminal(projectId);
    }
  }

  async function pick(shell: ShellOption) {
    open = false;
    const projectId = app.currentProjectId;
    if (!projectId) return;
    await launchShell(shell, projectId);
  }

  function handleDocClick(e: MouseEvent) {
    if (!open) return;
    const target = e.target as Node;
    if (triggerRoot?.contains(target) || menu?.contains(target)) return;
    open = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) open = false;
  }

  onMount(() => {
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKeydown);
  });

  onDestroy(() => {
    document.removeEventListener("click", handleDocClick);
    document.removeEventListener("keydown", handleKeydown);
  });
</script>

<div bind:this={triggerRoot} class="relative flex items-stretch">
  <button
    type="button"
    class="flex shrink-0 items-center gap-1.5 rounded-l-md border border-r-0 border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    disabled={app.currentProjectId === null}
    onclick={launchDefault}
    title={defaultShell ? `Launch ${defaultShell.label}` : "New blank terminal"}
    aria-label="Launch terminal"
  >
    <Plus class="size-3.5" />
    <span>Terminal</span>
  </button>
  <button
    type="button"
    class="flex shrink-0 items-center justify-center rounded-r-md border border-dashed border-border px-1.5 py-1 text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    disabled={app.currentProjectId === null || platform.shells.length === 0}
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    title="Pick a shell"
    aria-label="Pick a shell"
  >
    <ChevronDown class="size-3.5" />
  </button>

  {#if open}
    <div
      bind:this={menu}
      role="menu"
      class="fixed z-[9999] flex min-w-44 flex-col rounded-md border border-border bg-[var(--color-surface-2)] p-1 shadow-xl"
      style:left="{menuPos.x}px"
      style:top="{menuPos.y}px"
      style:transform-origin="top left"
      transition:scale={{ duration: 90, start: 0.96 }}
    >
      {#if platform.shells.length === 0}
        <div class="px-2 py-1.5 text-[11px] text-muted-foreground">
          No shells detected
        </div>
      {/if}
      {#each platform.shells as shell (shell.id)}
        <button
          type="button"
          role="menuitem"
          class="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-[11.5px] text-foreground/85 transition hover:bg-accent hover:text-foreground"
          onclick={() => pick(shell)}
        >
          <span class="font-medium">{shell.label}</span>
          <span class="font-mono text-[10px] text-muted-foreground/70">{shell.id}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
