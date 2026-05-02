<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { platform } from "$lib/storage/platform.svelte";
  import { launchShell } from "$lib/features/thread/api";
  import type { ShellOption } from "$lib/storage/platform.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  let open = $state(false);
  let trigger: HTMLButtonElement | null = $state(null);
  let menu: HTMLDivElement | null = $state(null);

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    open = !open;
  }

  function closeMenu() {
    open = false;
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
    if (
      trigger?.contains(target) ||
      menu?.contains(target)
    ) {
      return;
    }
    open = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      open = false;
    }
  }

  onMount(() => {
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

<div class="relative">
  <button
    bind:this={trigger}
    type="button"
    class="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    disabled={app.currentProjectId === null}
    onclick={toggle}
    title="New terminal"
    aria-label="New terminal"
    aria-expanded={open}
    aria-haspopup="menu"
  >
    <Plus class="size-3" />
    <span>Terminal</span>
    <ChevronDown class="size-3 opacity-60" />
  </button>

  {#if open}
    <div
      bind:this={menu}
      role="menu"
      class="absolute left-0 top-full z-30 mt-1 flex min-w-44 flex-col rounded-md border border-border bg-[var(--color-surface-2)] p-1 shadow-xl"
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
          <span class="font-mono text-[10px] text-muted-foreground/70">
            {shell.id}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
