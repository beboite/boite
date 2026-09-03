<script lang="ts">
  import { onMount } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { edgeFade } from "$lib/shared/actions/edgeFade";
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { platform } from "$lib/storage/platform.svelte";
  import type { ShellOption } from "$lib/storage/platform.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import {
    launchBlankTerminal,
    launchShell,
    launchShortcut,
    launchTargetProjectId,
  } from "$lib/features/thread/api";
  import { launchTargetMenu } from "./launchMenu";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import ShellPicker from "./ShellPicker.svelte";
  import FastpickPicker from "$lib/features/fastpick/FastpickPicker.svelte";
  import FastpickMenu from "$lib/features/fastpick/FastpickMenu.svelte";
  import { fastpick } from "$lib/features/fastpick/store.svelte";
  import { registerEscape } from "$lib/shared/keyboard/overlay";
  import { longPress } from "$lib/shared/actions/longPress";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import { t } from "$lib/i18n/index.svelte";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import Sparkles from "@lucide/svelte/icons/sparkles";

  // A plain click on no project already lands in Scratch; the menu — and the
  // shift-click behind it — is how you get there without giving up the project
  // you are on. Except when the launcher was opened from a project's own row:
  // that project IS the answer, and asking again would be asking twice.
  async function launch(shortcutId: string, forceScratch: boolean) {
    const shortcut = settings.state.shortcuts.find((s) => s.id === shortcutId);
    if (!shortcut) return;
    const target = projectId ?? (await launchTargetProjectId(forceScratch));
    if (!target) return;
    await launchShortcut(shortcut, target);
    onLaunched?.();
  }

  let ctxMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );

  function openMenu(shortcutId: string, x: number, y: number) {
    ctxMenu = {
      x,
      y,
      items: launchTargetMenu((forceScratch) => void launch(shortcutId, forceScratch)),
    };
  }

  /**
   * The launcher: every agent the user has configured, the shell picker and the
   * fastpick menu, in one place.
   *
   * It used to be a 40px strip across the top of the main area, permanently
   * offering something you do a handful of times a session, in the space the
   * agent's own output wants — and it owned the slot the editor needs for its
   * tabs. It is a popover off a project's `+` now.
   *
   * `compact` is that popover, and it is one menu that walks between panes, not a
   * menu that opens more menus. The agents first, then fastpick, then the
   * terminal: fastpick is a launch like the ones above it, a plain shell is what
   * you take when none of them fits, so it sits at the bottom. Both used to open
   * a second floating box on top of this one, which meant picking a model across
   * two stacked popovers; they replace the list in place now, the way fastpick's
   * own three steps already did.
   *
   * `projectId` is the row it was opened from, which spares the launch the
   * "where does this land" question the strip had to ask with a second menu.
   */
  type Props = {
    compact?: boolean;
    projectId?: string | null;
    onLaunched?: () => void;
    /** Escape at the top of the walk: nothing left to go back to, so it closes. */
    onClose?: () => void;
  };
  let { compact = false, projectId = null, onLaunched, onClose }: Props = $props();

  type Pane = "root" | "shell" | "fastpick";
  let pane = $state<Pane>("root");

  const fastpickAvailable = $derived(
    settings.state.fastpickEnabled && fastpick.installed !== false,
  );

  // Which machine the shell pane is about. A shell list belongs to one machine
  // and dynamic mode has two, so the rows come from the one the launch would
  // land on: this pane used to offer the local machine's shells for a project
  // running on the boite, and picking one sent a Windows shell path there.
  const targetOrigin = $derived(
    app.projectById(projectId ?? app.currentProjectId)?.origin,
  );
  const shells = $derived(platform.shellsFor(targetOrigin));
  const onBoite = $derived(platform.shellsOnBoite(targetOrigin));

  const defaultShell = $derived(
    settings.state.defaultShellId
      ? shells.find((s) => s.id === settings.state.defaultShellId) ?? null
      : null,
  );

  async function launchDefaultShell(forceScratch: boolean) {
    // Same order as `pickShell` and the fastpick walk: the prop is a getter over
    // the launcher's own state, and `onLaunched` is what clears it.
    const own = projectId;
    onLaunched?.();
    const target = own ?? (await launchTargetProjectId(forceScratch));
    if (!target) return;
    if (defaultShell) await launchShell(defaultShell, target);
    else await launchBlankTerminal(target);
  }

  async function pickShell(shell: ShellOption, forceScratch: boolean) {
    const own = projectId;
    onLaunched?.();
    const target = own ?? (await launchTargetProjectId(forceScratch));
    if (!target) return;
    await launchShell(shell, target);
  }

  $effect(() => {
    if (!compact) return;
    return registerEscape(() => {
      if (pane === "root") onClose?.();
      else pane = "root";
    });
  });

  onMount(() => {
    // The fastpick row hides itself on a machine with no fastpick, and only the
    // probe knows. In the bar, `FastpickPicker` asks; here nothing else would.
    if (compact && settings.state.fastpickEnabled) void fastpick.ensure();
  });

  function tooltip(label: string, command: string): string {
    const head = compact ? `${label}\n` : "";
    return `${head}${command || t("shortcuts.emptyCommand")}\n${t("shortcuts.rightClickHint")}`;
  }

  function openSettings() {
    app.view = "settings";
  }

  const rowClass =
    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-foreground transition hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:focus-ring-inset disabled:cursor-not-allowed disabled:opacity-40";
</script>

<!-- Compact carries no surface of its own: it is the contents of a popover, and
     the popover owns the background, the border and the radius. Painting a
     second opaque box in here squared off the corners it sits inside. -->
{#if compact && pane === "fastpick"}
  <FastpickMenu
    {projectId}
    {onLaunched}
    onExit={() => (pane = "root")}
  />
{:else if compact && pane === "shell"}
  <div class="flex min-h-0 flex-1 flex-col">
    <div
      class="flex items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs text-muted-foreground"
    >
      <button
        type="button"
        class="flex items-center rounded p-0.5 transition hover:bg-accent hover:text-foreground"
        onclick={() => (pane = "root")}
        aria-label={t("fastpick.back")}
        use:tip={t("fastpick.back")}
      >
        <ChevronLeft class="size-3.5" />
      </button>
      <span class="truncate font-medium">{t("shell.pick")}</span>
      {#if onBoite}
        <!-- The list changed machine when the project did, and nothing else on
             screen says which one these shells belong to. -->
        <span class="ml-auto shrink-0 text-xs text-muted-2">
          {t("sidebar.onBoite", { name: workspace.info.name || "boite" })}
        </span>
      {/if}
    </div>
    <div class="flex min-h-0 flex-col scroll-pane overflow-y-auto p-1.5">
      {#if shells.length === 0}
        <div class="px-2 py-1.5 text-sm text-muted-foreground">
          {t("shell.noneDetected")}
        </div>
      {/if}
      {#each shells as shell (shell.id)}
        <button type="button" class={rowClass} onclick={(e) => void pickShell(shell, e.shiftKey)}>
          <span class="min-w-0 truncate font-medium">{shell.label}</span>
          <span class="ml-auto shrink-0 text-xs text-muted-2">
            {shell.id}
          </span>
        </button>
      {/each}
    </div>
  </div>
{:else}
  <div
    class={compact
      ? "flex min-h-0 flex-1 flex-col p-1.5"
      : "flex h-10 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-surface)] px-3"}
  >
    <!-- hide-scrollbar: the global scrollbar is 10px, a quarter of this 40px bar,
         and the other horizontal strips already hide theirs. Compact stacks
         instead: a sidebar that scrolls sideways hides half its own buttons. -->
    <div
      class={compact
        ? "flex min-h-0 flex-col gap-0.5 scroll-pane overflow-y-auto"
        : "edge-fade hide-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"}
      use:edgeFade
    >
      {#each settings.state.shortcuts as shortcut (shortcut.id)}
        {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
        <button
          type="button"
          class={compact
            ? rowClass
            : "press group flex shrink-0 items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2.5 py-1 text-sm text-foreground hover:border-edge hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"}
          disabled={!shortcut.command.trim()}
          onclick={(e) => void launch(shortcut.id, e.shiftKey)}
          oncontextmenu={(e) => {
            e.preventDefault();
            openMenu(shortcut.id, e.clientX, e.clientY);
          }}
          use:longPress={{ onLongPress: (x, y) => openMenu(shortcut.id, x, y) }}
          use:tip={tooltip(shortcut.label, shortcut.command)}
        >
          <ShortcutIcon {iconKey} size={15} color={shortcut.iconColor ?? null} />
          <!-- Truncated rather than wrapped: the popover is as wide as the project
               card, and a two-line row would break the rhythm the list reads by. -->
          <span class="min-w-0 truncate font-medium">{shortcut.label}</span>
        </button>
      {/each}

      {#if settings.state.shortcuts.length === 0}
        <button
          type="button"
          class="shrink-0 text-sm text-muted-foreground transition hover:text-foreground"
          onclick={openSettings}
        >
          {t("shortcuts.addShortcuts")}
        </button>
      {/if}

      {#if !compact}
        <ShellPicker {projectId} {onLaunched} />
        <FastpickPicker {projectId} {onLaunched} />
      {/if}
    </div>

    <!-- Under a hairline, and both step into the list rather than over it. The
         terminal keeps its two targets: the row launches the default shell, the
         chevron is the one that asks which. -->
    {#if compact}
      <div class="mt-1 flex shrink-0 flex-col gap-0.5 border-t border-border/50 pt-1">
        {#if fastpickAvailable}
          <button
            type="button"
            class="{rowClass} text-muted-foreground"
            onclick={() => (pane = "fastpick")}
            use:tip={t("fastpick.tooltip")}
          >
            <Sparkles class="size-3.5 shrink-0" />
            <span class="min-w-0 truncate">{t("fastpick.label")}</span>
            <ChevronRight class="ml-auto size-3.5 shrink-0 opacity-50" />
          </button>
        {/if}
        <div class="group flex items-stretch rounded-md transition hover:bg-accent">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-muted-foreground transition group-hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
            onclick={(e) => void launchDefaultShell(e.shiftKey)}
            use:tip={defaultShell
              ? t("shell.launchNamed", { name: defaultShell.label })
              : t("shell.newBlank")}
          >
            <TerminalIcon class="size-3.5 shrink-0" />
            <span class="min-w-0 truncate">{t("tabs.terminal")}</span>
          </button>
          <button
            type="button"
            class="flex shrink-0 items-center rounded-r-md border-l border-border/60 px-1.5 text-muted-2 transition hover:bg-[var(--color-surface-3)] hover:text-foreground focus-visible:bg-[var(--color-surface-3)] focus-visible:text-foreground focus-visible:outline-none group-hover:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={shells.length === 0}
            onclick={() => (pane = "shell")}
            aria-label={t("shell.pick")}
            use:tip={t("shell.pick")}
          >
            <ChevronRight class="size-3.5" />
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

{#if ctxMenu}
  <ContextMenu
    items={ctxMenu.items}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onClose={() => (ctxMenu = null)}
  />
{/if}
