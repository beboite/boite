<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import type { MobileTab } from "$lib/types";
  import type { Component } from "svelte";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Boxes from "@lucide/svelte/icons/boxes";
  import Settings from "@lucide/svelte/icons/settings";

  const TABS: { id: MobileTab; label: string; icon: Component }[] = [
    { id: "files", label: "Files", icon: FolderTree },
    { id: "git", label: "Git", icon: GitBranch },
    { id: "terminal", label: "Terminal", icon: SquareTerminal },
    { id: "projects", label: "Projects", icon: Boxes },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  function select(tab: MobileTab) {
    app.mobileTab = tab;
    // Diff/editor overlays sit above the tab pages; leaving them when the user
    // taps a tab keeps the bottom bar honest about what's on screen.
    if (app.view === "editor" || app.view === "settings") app.view = "terminal";
  }
</script>

<nav
  class="flex shrink-0 items-stretch border-t border-border bg-[var(--color-titlebar)]"
  style="padding-bottom: env(safe-area-inset-bottom, 0px);"
>
  {#each TABS as tab (tab.id)}
    {@const Icon = tab.icon}
    {@const active = app.mobileTab === tab.id}
    <button
      type="button"
      class="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition active:bg-accent/40 {active
        ? 'text-foreground'
        : 'text-muted-foreground'}"
      onclick={() => select(tab.id)}
      aria-current={active ? "page" : undefined}
    >
      <Icon class="size-5" />
      <span class="text-2xs font-medium tracking-tight">{tab.label}</span>
    </button>
  {/each}
</nav>
