<script lang="ts">
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { launchShortcut, launchTargetProjectId } from "$lib/features/thread/api";
  import { launchTargetMenu } from "./launchMenu";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import ContextMenu from "$lib/shared/components/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";
  import ShellPicker from "./ShellPicker.svelte";
  import FastpickPicker from "$lib/features/fastpick/FastpickPicker.svelte";
  import { longPress } from "$lib/shared/actions/longPress";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import { t } from "$lib/i18n/index.svelte";

  // A plain click on no project already lands in Scratch; the menu — and the
  // shift-click behind it — is how you get there without giving up the project
  // you are on.
  async function launch(shortcutId: string, forceScratch: boolean) {
    const shortcut = settings.state.shortcuts.find((s) => s.id === shortcutId);
    if (!shortcut) return;
    const projectId = await launchTargetProjectId(forceScratch);
    if (!projectId) return;
    await launchShortcut(shortcut, projectId);
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

  function tooltip(command: string): string {
    return `${command || t("shortcuts.emptyCommand")}\n${t("shortcuts.rightClickHint")}`;
  }

  function openSettings() {
    app.view = "settings";
  }
</script>

<div
  class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-surface)] px-3"
>
  <!-- hide-scrollbar: the global scrollbar is 10px, a quarter of this 40px bar,
       and the other horizontal strips already hide theirs. -->
  <div class="hide-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
    {#each settings.state.shortcuts as shortcut (shortcut.id)}
      {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
      <button
        type="button"
        class="group flex shrink-0 items-center gap-1.5 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2.5 py-1 text-xs text-foreground/85 transition hover:border-border hover:bg-[var(--color-surface-3)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!shortcut.command.trim()}
        onclick={(e) => void launch(shortcut.id, e.shiftKey)}
        oncontextmenu={(e) => {
          e.preventDefault();
          openMenu(shortcut.id, e.clientX, e.clientY);
        }}
        use:longPress={{ onLongPress: (x, y) => openMenu(shortcut.id, x, y) }}
        title={tooltip(shortcut.command)}
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
        {t("shortcuts.addShortcuts")}
      </button>
    {/if}

    <ShellPicker />
    <FastpickPicker />
  </div>
</div>

{#if ctxMenu}
  <ContextMenu
    items={ctxMenu.items}
    x={ctxMenu.x}
    y={ctxMenu.y}
    onClose={() => (ctxMenu = null)}
  />
{/if}
