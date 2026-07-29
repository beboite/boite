<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { app } from "$lib/app/store.svelte";
  import { launchShortcut } from "$lib/features/thread/api";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import ShellPicker from "./ShellPicker.svelte";
  import FastpickPicker from "$lib/features/fastpick/FastpickPicker.svelte";
  import { resolveIconKey } from "$lib/shared/icons/detect";

  function launch(shortcutId: string) {
    const shortcut = settings.state.shortcuts.find((s) => s.id === shortcutId);
    if (!shortcut) return;
    const projectId = app.currentProjectId;
    if (!projectId) return;
    void launchShortcut(shortcut, projectId);
  }

  function openSettings() {
    app.view = "settings";
  }
</script>

<div
  class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-surface)] px-3"
>
  <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
    {#each settings.state.shortcuts as shortcut (shortcut.id)}
      {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
      <button
        type="button"
        class="group flex shrink-0 items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground/85 transition hover:border-border hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={app.currentProjectId === null || !shortcut.command.trim()}
        onclick={() => launch(shortcut.id)}
        title={shortcut.command || "Empty command"}
      >
        <ShortcutIcon {iconKey} size={15} color={shortcut.iconColor ?? null} />
        <span class="font-medium">{shortcut.label}</span>
      </button>
    {/each}

    {#if settings.state.shortcuts.length === 0}
      <button
        type="button"
        class="shrink-0 text-xs text-muted-foreground transition hover:text-foreground"
        onclick={openSettings}
      >
        Add shortcuts
      </button>
    {/if}

    <ShellPicker />
    <FastpickPicker />
  </div>
</div>
