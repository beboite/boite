<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { platform } from "$lib/storage/platform.svelte";
  import {
    launchShortcut,
    launchShell,
    launchBlankTerminal,
  } from "$lib/features/thread/api";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import type { ShellOption } from "$lib/storage/platform.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import MobileSheet from "./MobileSheet.svelte";
  import TerminalIcon from "@lucide/svelte/icons/square-terminal";

  type Props = { open: boolean; onClose: () => void };
  let { open, onClose }: Props = $props();

  // Launching always targets the project the top bar is showing.
  const projectId = $derived(app.currentProjectId);

  function goTerminal() {
    onClose();
    app.mobileTab = "terminal";
  }

  async function runShortcut(id: string) {
    const shortcut = settings.state.shortcuts.find((s) => s.id === id);
    if (!shortcut || !projectId) return;
    goTerminal();
    await launchShortcut(shortcut, projectId);
  }

  async function runShell(shell: ShellOption) {
    if (!projectId) return;
    goTerminal();
    await launchShell(shell, projectId);
  }

  async function runBlank() {
    if (!projectId) return;
    goTerminal();
    await launchBlankTerminal(projectId);
  }
</script>

<MobileSheet {open} {onClose} title="New terminal">
  {#if settings.state.shortcuts.length > 0}
    <div class="grid grid-cols-2 gap-2">
      {#each settings.state.shortcuts as shortcut (shortcut.id)}
        {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
        <button
          type="button"
          class="flex items-center gap-3 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-3 text-left text-sm text-foreground/90 transition active:scale-[0.98] active:bg-[var(--color-surface-3)] disabled:opacity-40"
          disabled={!projectId || !shortcut.command.trim()}
          onclick={() => runShortcut(shortcut.id)}
        >
          <ShortcutIcon {iconKey} size={20} color={shortcut.iconColor ?? null} />
          <span class="min-w-0 flex-1 truncate font-medium">{shortcut.label}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="mt-3 mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
    Shells
  </div>
  <div class="flex flex-col gap-1.5">
    <button
      type="button"
      class="flex items-center gap-3 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-3 text-left text-sm text-foreground/90 transition active:scale-[0.98] active:bg-[var(--color-surface-3)] disabled:opacity-40"
      disabled={!projectId}
      onclick={runBlank}
    >
      <TerminalIcon class="size-5 text-muted-foreground" />
      <span class="font-medium">Default shell</span>
    </button>
    {#each platform.shells as shell (shell.id)}
      <button
        type="button"
        class="flex items-center justify-between gap-3 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-3 text-left text-sm text-foreground/90 transition active:scale-[0.98] active:bg-[var(--color-surface-3)] disabled:opacity-40"
        disabled={!projectId}
        onclick={() => runShell(shell)}
      >
        <span class="min-w-0 flex-1 truncate font-medium">{shell.label}</span>
        <span class="shrink-0 font-mono text-[11px] text-muted-foreground/70">{shell.id}</span>
      </button>
    {/each}
  </div>
</MobileSheet>
