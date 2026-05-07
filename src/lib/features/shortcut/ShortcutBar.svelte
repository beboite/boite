<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { app } from "$lib/app/store.svelte";
  import { launchShortcut } from "$lib/features/thread/api";
  import { gitStore } from "$lib/features/git/store.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import ShellPicker from "./ShellPicker.svelte";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import FolderTree from "@lucide/svelte/icons/folder-tree";

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

  function toggleGit() {
    void settings.toggleRightPanel("git");
  }

  function toggleExplorer() {
    void settings.toggleRightPanel("explorer");
  }

  const gitState = $derived(gitStore.get(app.currentProjectId));
  const gitActive = $derived(settings.state.rightPanel === "git");
  const explorerActive = $derived(settings.state.rightPanel === "explorer");
  const changeCount = $derived(
    gitState
      ? gitState.staged.length + gitState.unstaged.length + gitState.conflicts.length
      : 0,
  );
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
        <ShortcutIcon {iconKey} size={15} />
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
  </div>

  <button
    type="button"
    class="relative flex shrink-0 items-center gap-1 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2 py-1 text-xs text-foreground/85 transition hover:border-border hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 {explorerActive ? 'border-border bg-[var(--color-surface-3)] text-foreground' : ''}"
    onclick={toggleExplorer}
    disabled={app.currentProjectId === null}
    title={explorerActive ? "Hide files panel" : "Show files panel"}
    aria-label="Toggle files panel"
    aria-pressed={explorerActive}
  >
    <FolderTree class="size-3.5" />
  </button>

  <button
    type="button"
    class="relative flex shrink-0 items-center gap-1 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2 py-1 text-xs text-foreground/85 transition hover:border-border hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 {gitActive ? 'border-border bg-[var(--color-surface-3)] text-foreground' : ''}"
    onclick={toggleGit}
    disabled={app.currentProjectId === null}
    title={gitActive ? "Hide git panel" : "Show git panel"}
    aria-label="Toggle git panel"
    aria-pressed={gitActive}
  >
    <GitBranch class="size-3.5" />
    {#if gitState?.branch}
      <span class="max-w-24 truncate">{gitState.branch}</span>
    {/if}
    {#if changeCount > 0}
      <span class="rounded-full bg-amber-400/20 px-1.5 text-[10px] font-medium text-amber-300">
        {changeCount}
      </span>
    {/if}
  </button>
</div>
