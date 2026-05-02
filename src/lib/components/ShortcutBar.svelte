<script lang="ts">
  import { settings } from "$lib/settings.svelte";
  import { app } from "$lib/store.svelte";
  import { launchShortcut, launchBlankTerminal } from "$lib/projects";
  import ShortcutIcon from "./ShortcutIcon.svelte";
  import Plus from "@lucide/svelte/icons/plus";

  function launch(shortcutId: string) {
    const shortcut = settings.state.shortcuts.find((s) => s.id === shortcutId);
    if (!shortcut) return;
    const projectId = app.currentProjectId;
    if (!projectId) return;
    launchShortcut(shortcut, projectId);
  }

  function openBlank() {
    const projectId = app.currentProjectId;
    if (!projectId) return;
    void launchBlankTerminal(projectId);
  }

  function openSettings() {
    app.view = "settings";
  }
</script>

<div
  class="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-[var(--color-surface)] px-3"
>
  {#each settings.state.shortcuts as shortcut (shortcut.id)}
    <button
      type="button"
      class="group flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2.5 py-1 text-[11.5px] text-foreground/85 transition hover:border-border hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={app.currentProjectId === null || !shortcut.command.trim()}
      onclick={() => launch(shortcut.id)}
      title={shortcut.command || "Empty command"}
    >
      <ShortcutIcon iconKey={shortcut.iconKey ?? null} size={13} />
      <span class="font-medium">{shortcut.label}</span>
    </button>
  {/each}

  <button
    type="button"
    class="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    disabled={app.currentProjectId === null}
    onclick={openBlank}
    title="New blank terminal"
    aria-label="New terminal"
  >
    <Plus class="size-3" />
    <span>Terminal</span>
  </button>

  <div class="flex-1"></div>

  {#if settings.state.shortcuts.length === 0}
    <button
      type="button"
      class="text-[11px] text-muted-foreground transition hover:text-foreground"
      onclick={openSettings}
    >
      Add shortcuts
    </button>
  {/if}
</div>
