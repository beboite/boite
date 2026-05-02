<script lang="ts">
  import { settings } from "$lib/settings.svelte";
  import { app } from "$lib/store.svelte";
  import { launchShortcut } from "$lib/projects";
  import Settings from "@lucide/svelte/icons/settings";
  import Zap from "@lucide/svelte/icons/zap";

  function launch(shortcutId: string) {
    const shortcut = settings.state.shortcuts.find((s) => s.id === shortcutId);
    if (!shortcut) return;
    const projectId = app.currentProjectId;
    if (!projectId) return;
    launchShortcut(shortcut, projectId);
  }

  function openSettings() {
    app.view = "settings";
  }
</script>

<div
  class="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-[var(--color-surface)] px-3"
>
  {#if settings.state.shortcuts.length === 0}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={openSettings}
    >
      <Zap class="size-3" />
      Add shortcuts
    </button>
  {:else}
    {#each settings.state.shortcuts as shortcut (shortcut.id)}
      <button
        type="button"
        class="group flex items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2.5 py-1 text-[11.5px] text-foreground/85 transition hover:border-border hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={app.currentProjectId === null || !shortcut.command.trim()}
        onclick={() => launch(shortcut.id)}
        title={shortcut.command || "Empty command"}
      >
        <Zap class="size-3 text-muted-foreground transition group-hover:text-warning" />
        <span class="font-medium">{shortcut.label}</span>
      </button>
    {/each}
  {/if}

  <div class="flex-1"></div>

  <button
    type="button"
    class="rounded-md p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
    onclick={openSettings}
    aria-label="Edit shortcuts"
    title="Edit shortcuts"
  >
    <Settings class="size-3.5" />
  </button>
</div>
