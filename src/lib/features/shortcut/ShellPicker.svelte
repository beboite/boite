<script lang="ts">
  import { tip } from "$lib/shared/actions/tooltip";
  import { scale } from "svelte/transition";
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { platform } from "$lib/storage/platform.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import {
    launchShell,
    launchBlankTerminal,
    launchTargetProjectId,
  } from "$lib/features/thread/api";
  import { launchTargetMenu } from "./launchMenu";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import { AnchoredMenu } from "$lib/shared/keyboard/anchoredMenu.svelte";
  import { longPress } from "$lib/shared/actions/longPress";
  import type { ShellOption } from "$lib/storage/platform.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * `projectId` names the project a launch lands in, set when this picker is
   * inside a project's own launcher. Null keeps the old behaviour: the selected
   * project, or Scratch when there is none.
   */
  type Props = {
    projectId?: string | null;
    onLaunched?: () => void;
  };
  let { projectId = null, onLaunched }: Props = $props();

  // Where it hangs, how it stays on screen, Escape and the click elsewhere. The
  // rows are buttons and this is a `role="menu"`, so the keyboard has to land
  // inside it the moment it opens.
  const menu = new AnchoredMenu((surface) => (menuItems()[0] ?? surface).focus());

  // Which machine this menu is about. A shell list belongs to one machine and
  // dynamic mode has two, so the rows come from the one the launch would land
  // on rather than from whichever list the store loaded first: the menu used to
  // offer this device's shells for a project running on the boite, and handing
  // one over sent a Windows shell path to a Linux machine. Resolved here rather
  // than at the click, because a menu is read before it is used.
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

  function menuItems(): HTMLButtonElement[] {
    return Array.from(
      menu.surface?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
  }

  function handleMenuKeydown(e: KeyboardEvent) {
    const buttons = menuItems();
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const last = buttons.length - 1;
    const wrap = (step: number) =>
      buttons[(idx + step + buttons.length) % buttons.length].focus();

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      if (idx < 0) buttons[down ? 0 : last].focus();
      else wrap(down ? 1 : -1);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      buttons[0].focus();
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      buttons[last].focus();
      return;
    }
    if (e.key === "Tab") {
      // Trapped: Tab out of an open dropdown left it floating over a bar the
      // keyboard had already left.
      e.preventDefault();
      if (idx < 0) buttons[e.shiftKey ? last : 0].focus();
      else wrap(e.shiftKey ? -1 : 1);
    }
    // Enter and Space need nothing: the rows are buttons.
  }

  // Right-click, long press or shift-click opens in Scratch without leaving
  // the current project, the same as on a shortcut. On no project the plain
  // click already lands there.
  async function launchDefault(forceScratch: boolean) {
    menu.open = false;
    const target = projectId ?? (await launchTargetProjectId(forceScratch));
    if (!target) return;
    if (defaultShell) {
      await launchShell(defaultShell, target);
    } else {
      await launchBlankTerminal(target);
    }
    onLaunched?.();
  }

  async function pick(shell: ShellOption, forceScratch: boolean) {
    menu.open = false;
    const target = projectId ?? (await launchTargetProjectId(forceScratch));
    if (!target) return;
    await launchShell(shell, target);
    onLaunched?.();
  }

  let ctxMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );

  function openMenu(x: number, y: number) {
    ctxMenu = {
      x,
      y,
      items: launchTargetMenu((forceScratch) => void launchDefault(forceScratch)),
    };
  }
</script>

<div bind:this={menu.trigger} class="relative flex shrink-0 items-stretch">
  <button
    type="button"
    class="flex shrink-0 items-center gap-1.5 rounded-l-md border border-r-0 border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    onclick={(e) => void launchDefault(e.shiftKey)}
    oncontextmenu={(e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    }}
    use:longPress={{ onLongPress: openMenu }}
    use:tip={defaultShell
      ? t("shell.launchNamed", { name: defaultShell.label })
      : t("shell.newBlank")}
    aria-label={t("shell.launchTerminal")}
  >
    <Plus class="size-3.5" />
    <span>{t("tabs.terminal")}</span>
  </button>
  <button
    type="button"
    class="flex shrink-0 items-center justify-center rounded-r-md border border-dashed border-border px-1.5 py-1 text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    disabled={shells.length === 0}
    onclick={(e) => menu.toggle(e)}
    aria-haspopup="menu"
    aria-expanded={menu.open}
    use:tip={t("shell.pick")}
    aria-label={t("shell.pick")}
  >
    <ChevronDown class="size-3.5" />
  </button>

  {#if menu.open}
    <div
      bind:this={menu.surface}
      role="menu"
      tabindex="-1"
      class="surface-popover fixed z-[var(--z-popover)] flex min-w-44 flex-col p-1"
      style:left="{menu.pos.x}px"
      style:top="{menu.pos.y}px"
      style:transform-origin="top left"
      onkeydown={handleMenuKeydown}
      transition:scale={{ duration: 90, start: 0.96 }}
    >
      {#if onBoite}
        <!-- The list changed machine when the project did, and nothing else on
             screen says which one these shells belong to. -->
        <div class="px-2 py-1 text-2xs text-muted-foreground/70">
          {t("sidebar.onBoite", { name: workspace.info.name || "boite" })}
        </div>
      {/if}
      {#if shells.length === 0}
        <div class="px-2 py-1.5 text-xs text-muted-foreground">
          {t("shell.noneDetected")}
        </div>
      {/if}
      {#each shells as shell (shell.id)}
        <button
          type="button"
          role="menuitem"
          class="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm text-foreground/80 transition hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
          onclick={(e) => void pick(shell, e.shiftKey)}
        >
          <span class="font-medium">{shell.label}</span>
          <span class="text-2xs text-muted-foreground/70">{shell.id}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

{#if ctxMenu}
  <ContextMenu
    items={ctxMenu.items}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onClose={() => (ctxMenu = null)}
  />
{/if}
