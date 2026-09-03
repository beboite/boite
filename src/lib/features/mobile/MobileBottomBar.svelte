<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { homeAvailable } from "$lib/features/settings/homeAvailable";
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import type { MobileTab } from "$lib/types";
  import type { Component } from "svelte";
  import FolderTree from "@lucide/svelte/icons/folder-tree";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Boxes from "@lucide/svelte/icons/boxes";
  import Settings from "@lucide/svelte/icons/settings";
  import Home from "@lucide/svelte/icons/home";

  // The label is a key, not a string: the bar is data-driven, so the literal
  // that svelte-check verifies lives here instead of at the render site.
  //
  // Todo sits beside the terminal because that is what it is for here: the list
  // is the one surface an agent writes into from the other side, so a phone
  // that could not open it could see what an agent was doing and never what it
  // had been asked to do.
  type Tab = { id: MobileTab; labelKey: MessageKey; icon: Component };
  const FILES: Tab = { id: "files", labelKey: "mobile.files", icon: FolderTree };
  const GIT: Tab = { id: "git", labelKey: "project.git", icon: GitBranch };
  const TERMINAL: Tab = { id: "terminal", labelKey: "tabs.terminal", icon: SquareTerminal };
  const TODO: Tab = { id: "todo", labelKey: "panes.kindTodo", icon: ListTodo };
  const PROJECTS: Tab = { id: "projects", labelKey: "sidebar.projects", icon: Boxes };
  const SETTINGS_TAB: Tab = { id: "settings", labelKey: "common.settings", icon: Settings };
  const HOME: Tab = { id: "home", labelKey: "home.title", icon: Home };

  // No home keeps the six-tab row this bar shipped with. Home reachable puts
  // it first and drops projects into the launch sheet, so the count stays six.
  const TABS = $derived(
    homeAvailable(settings.state)
      ? [HOME, FILES, GIT, TERMINAL, TODO, SETTINGS_TAB]
      : [FILES, GIT, TERMINAL, TODO, PROJECTS, SETTINGS_TAB],
  );

  function select(tab: MobileTab) {
    app.mobileTab = tab;
    // Home is a view of its own. Forcing terminal here would cover it the way
    // the project dashboard used to cover a tab tap.
    if (tab === "home") {
      app.view = "home";
      return;
    }
    // Diff/editor overlays sit above the tab pages; leaving them when the user
    // taps a tab keeps the bottom bar honest about what's on screen. `project`
    // is one of them: the dashboard is opened over the terminal page, and
    // without this a tap moved the tab underneath it and changed nothing.
    if (app.view !== "terminal") app.view = "terminal";
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
      class="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 py-2 transition active:bg-accent/40 {active
        ? 'text-foreground'
        : 'text-muted-foreground'}"
      onclick={() => select(tab.id)}
      aria-current={active ? "page" : undefined}
    >
      <Icon class="size-5" />
      <!-- Six tabs now, and a French label is half again as long as its English
           twin: the row has to give up the word rather than the tap target. -->
      <span class="w-full truncate text-center text-xs font-medium tracking-tight">
        {t(tab.labelKey)}
      </span>
    </button>
  {/each}
</nav>
