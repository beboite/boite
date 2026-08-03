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
   * `compact` is that popover: 220px, wrapped icons rather than labelled chips.
   * `projectId` is the row it was opened from, which spares the launch the
   * "where does this land" question the strip had to ask with a second menu.
   */
  type Props = {
    compact?: boolean;
    projectId?: string | null;
    onLaunched?: () => void;
  };
  let { compact = false, projectId = null, onLaunched }: Props = $props();

  function tooltip(label: string, command: string): string {
    const head = compact ? `${label}\n` : "";
    return `${head}${command || t("shortcuts.emptyCommand")}\n${t("shortcuts.rightClickHint")}`;
  }

  function openSettings() {
    app.view = "settings";
  }
</script>

<!-- Compact carries no surface of its own: it is the contents of a popover, and
     the popover owns the background, the border and the radius. Painting a
     second opaque box in here squared off the corners it sits inside. -->
<div
  class={compact
    ? "shrink-0 p-1.5"
    : "flex h-10 shrink-0 items-center gap-2 border-b border-border bg-[var(--color-surface)] px-3"}
>
  <!-- hide-scrollbar: the global scrollbar is 10px, a quarter of this 40px bar,
       and the other horizontal strips already hide theirs. Compact wraps
       instead: a sidebar that scrolls sideways hides half its own buttons. -->
  <div
    class={compact
      ? "flex flex-wrap items-center gap-1"
      : "hide-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto"}
  >
    {#each settings.state.shortcuts as shortcut (shortcut.id)}
      {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
      <button
        type="button"
        class="group flex shrink-0 items-center text-xs text-foreground/85 transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 {compact
          ? 'size-8 justify-center rounded-md hover:bg-accent'
          : 'gap-1.5 rounded-md border border-transparent bg-[var(--color-surface-2)] px-2.5 py-1 hover:border-border hover:bg-[var(--color-surface-3)]'}"
        disabled={!shortcut.command.trim()}
        onclick={(e) => void launch(shortcut.id, e.shiftKey)}
        oncontextmenu={(e) => {
          e.preventDefault();
          openMenu(shortcut.id, e.clientX, e.clientY);
        }}
        use:longPress={{ onLongPress: (x, y) => openMenu(shortcut.id, x, y) }}
        title={tooltip(shortcut.label, shortcut.command)}
        aria-label={compact ? shortcut.label : undefined}
      >
        <ShortcutIcon {iconKey} size={15} color={shortcut.iconColor ?? null} />
        {#if !compact}
          <span class="font-medium">{shortcut.label}</span>
        {/if}
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

    {#if !compact}
      <ShellPicker {projectId} {onLaunched} />
      <FastpickPicker {projectId} {onLaunched} />
    {/if}
  </div>

  <!-- Stacked under a hairline in the popover: side by side they were two
       dashed pills competing with the icons above them, in 200px. -->
  {#if compact}
    <div class="mt-1 flex flex-col gap-0.5 border-t border-border/50 pt-1">
      <ShellPicker {projectId} {onLaunched} compact />
      <FastpickPicker {projectId} {onLaunched} compact />
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
