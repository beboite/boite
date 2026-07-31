<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import type { MobileTab } from "$lib/types";
  import type { Component } from "svelte";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Boxes from "@lucide/svelte/icons/boxes";
  import Settings from "@lucide/svelte/icons/settings";

  // The label is a key, not a string: the bar is data-driven, so the literal
  // that svelte-check verifies lives here instead of at the render site.
  const TABS: { id: MobileTab; labelKey: MessageKey; icon: Component }[] = [
    { id: "files", labelKey: "mobile.files", icon: FolderTree },
    { id: "git", labelKey: "project.git", icon: GitBranch },
    { id: "terminal", labelKey: "tabs.terminal", icon: SquareTerminal },
    { id: "projects", labelKey: "sidebar.projects", icon: Boxes },
    { id: "settings", labelKey: "common.settings", icon: Settings },
  ];

  function select(tab: MobileTab) {
    app.mobileTab = tab;
    // Diff/editor overlays sit above the tab pages; leaving them when the user
    // taps a tab keeps the bottom bar honest about what's on screen.
    if (app.view === "editor" || app.view === "settings") app.view = "terminal";
  }
</script>

<!-- The side insets are what keep the outer two tabs reachable in landscape on a
     notched phone: the bar spans the window, so the cutout eats the Files and
     Settings targets without them. -->
<nav
  class="flex shrink-0 items-stretch border-t border-border bg-[var(--color-titlebar)]"
  style="padding-bottom: env(safe-area-inset-bottom, 0px); padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px);"
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
      <span class="text-2xs font-medium tracking-tight">{t(tab.labelKey)}</span>
    </button>
  {/each}
</nav>
