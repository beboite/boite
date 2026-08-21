<script module lang="ts">
  // One picker for the whole mobile layout. The top bar mounts it once and is
  // itself always on screen, so every other surface asks that instance to open
  // rather than mounting its own: two copies meant two independent `open`
  // flags, and closing one left the other believing it was still up.
  export const launchSheet = $state({ open: false });
</script>

<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { workspace } from "$lib/backend";
  import { settings } from "$lib/features/settings/store.svelte";
  import { homeAvailable } from "$lib/features/settings/homeAvailable";
  import { platform } from "$lib/storage/platform.svelte";
  import {
    launchShortcut,
    launchShell,
    launchBlankTerminal,
    launchTargetProjectId,
  } from "$lib/features/thread/api";
  import { launchTargetMenu } from "$lib/features/shortcut/launchMenu";
  import { t } from "$lib/i18n/index.svelte";
  import { longPress } from "$lib/shared/actions/longPress";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import type { ShellOption } from "$lib/storage/platform.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import MobileSheet from "./MobileSheet.svelte";
  import TerminalIcon from "@lucide/svelte/icons/square-terminal";
  import Boxes from "@lucide/svelte/icons/boxes";

  type Props = { open: boolean; onClose: () => void };
  let { open, onClose }: Props = $props();

  // Launching targets the project the top bar is showing, or Scratch when it
  // is showing none. Holding a row down is the phone's right-click: it opens
  // the same menu, which is the only way here to ask for Scratch while a
  // project is up.
  //
  // Which machine the shells come from follows that same target. A shell list
  // belongs to one machine and dynamic mode has two, so the sheet used to list
  // this device's shells for a project running on the boite. Scratch is always
  // local, hence the fallback.
  const targetOrigin = $derived(app.projectById(app.currentProjectId)?.origin);
  const shells = $derived(platform.shellsFor(targetOrigin));
  const onBoite = $derived(platform.shellsOnBoite(targetOrigin));

  function goTerminal() {
    onClose();
    app.mobileTab = "terminal";
  }

  function goProjects() {
    onClose();
    app.mobileTab = "projects";
    app.view = "terminal";
  }

  async function runShortcut(id: string, forceScratch = false) {
    const shortcut = settings.state.shortcuts.find((s) => s.id === id);
    const projectId = await launchTargetProjectId(forceScratch);
    if (!shortcut || !projectId) return;
    goTerminal();
    await launchShortcut(shortcut, projectId);
  }

  async function runShell(shell: ShellOption, forceScratch = false) {
    const projectId = await launchTargetProjectId(forceScratch);
    if (!projectId) return;
    goTerminal();
    await launchShell(shell, projectId);
  }

  async function runBlank(forceScratch = false) {
    const projectId = await launchTargetProjectId(forceScratch);
    if (!projectId) return;
    goTerminal();
    await launchBlankTerminal(projectId);
  }

  let ctxMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(
    null,
  );

  function openMenu(x: number, y: number, run: (forceScratch: boolean) => void) {
    ctxMenu = { x, y, items: launchTargetMenu(run) };
  }
</script>

<MobileSheet {open} {onClose} title={t("mobile.newTerminal")}>
  {#if homeAvailable(settings.state)}
    <button
      type="button"
      class="mb-3 flex w-full items-center gap-3 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-3 text-left text-sm text-foreground/90 transition active:scale-[0.98] active:bg-[var(--color-surface-3)]"
      onclick={goProjects}
    >
      <Boxes class="size-5 text-muted-foreground" />
      <span class="font-medium">{t("sidebar.projects")}</span>
    </button>
  {/if}
  {#if settings.state.shortcuts.length > 0}
    <div class="grid grid-cols-2 gap-2">
      {#each settings.state.shortcuts as shortcut (shortcut.id)}
        {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
        <button
          type="button"
          class="flex items-center gap-3 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-3 text-left text-sm text-foreground/90 transition active:scale-[0.98] active:bg-[var(--color-surface-3)] disabled:opacity-40"
          disabled={!shortcut.command.trim()}
          onclick={() => runShortcut(shortcut.id)}
          use:longPress={{
            onLongPress: (x, y) =>
              openMenu(x, y, (scratch) => void runShortcut(shortcut.id, scratch)),
          }}
        >
          <ShortcutIcon {iconKey} size={20} color={shortcut.iconColor ?? null} />
          <span class="min-w-0 flex-1 truncate font-medium">{shortcut.label}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div
    class="mt-3 mb-1 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
  >
    <span>{t("mobile.shells")}</span>
    {#if onBoite}
      <!-- The list changed machine when the project did, and nothing else on
           screen says which one these shells belong to. -->
      <span class="ml-auto normal-case tracking-normal text-muted-foreground/70">
        {t("sidebar.onBoite", { name: workspace.info.name || "boite" })}
      </span>
    {/if}
  </div>
  <div class="flex flex-col gap-1.5">
    <button
      type="button"
      class="flex items-center gap-3 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-3 text-left text-sm text-foreground/90 transition active:scale-[0.98] active:bg-[var(--color-surface-3)] disabled:opacity-40"
      onclick={() => runBlank()}
      use:longPress={{
        onLongPress: (x, y) => openMenu(x, y, (scratch) => void runBlank(scratch)),
      }}
    >
      <TerminalIcon class="size-5 text-muted-foreground" />
      <span class="font-medium">{t("mobile.defaultShell")}</span>
    </button>
    {#each shells as shell (shell.id)}
      <button
        type="button"
        class="flex items-center justify-between gap-3 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-3 text-left text-sm text-foreground/90 transition active:scale-[0.98] active:bg-[var(--color-surface-3)] disabled:opacity-40"
        onclick={() => runShell(shell)}
        use:longPress={{
          onLongPress: (x, y) =>
            openMenu(x, y, (scratch) => void runShell(shell, scratch)),
        }}
      >
        <span class="min-w-0 flex-1 truncate font-medium">{shell.label}</span>
        <span class="shrink-0 text-xs text-muted-foreground/70">{shell.id}</span>
      </button>
    {/each}
  </div>
</MobileSheet>

{#if ctxMenu}
  <ContextMenu
    items={ctxMenu.items}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onClose={() => (ctxMenu = null)}
  />
{/if}
