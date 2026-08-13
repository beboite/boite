<script lang="ts">
  import { onMount } from "svelte";
  import { workspace } from "$lib/backend";
  import { settings } from "./store.svelte";
  import { CLI_PRESETS } from "./cliPresets";
  import { cliDetection } from "./cliDetection.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { registerEscape, restoreFocus } from "$lib/shared/keyboard/overlay";
  import Plus from "@lucide/svelte/icons/plus";
  import Check from "@lucide/svelte/icons/check";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { t } from "$lib/i18n/index.svelte";
  import type { IconKey, Shortcut } from "$lib/types";

  const shortcuts = $derived(settings.state.shortcuts);

  function onUpdate(id: string, patch: Partial<Omit<Shortcut, "id">>) {
    void settings.updateShortcut(id, patch);
  }
  // Both destroyers ask first. A shortcut is a line the user typed and a reset
  // takes the whole bar back to the presets, and neither leaves anything behind
  // to undo it from.
  async function onRemove(shortcut: Shortcut) {
    const ok = await confirmDialog.ask({
      title: t("shortcuts.removeConfirmTitle"),
      message: t("shortcuts.removeConfirmMessage", { label: shortcut.label }),
      confirmLabel: t("shortcuts.remove"),
      danger: true,
    });
    if (!ok) return;
    await settings.removeShortcut(shortcut.id);
  }
  function onAdd(init: Partial<Shortcut>) {
    void settings.addShortcut(init);
  }
  function onReorder(orderedIds: string[]) {
    void settings.reorderShortcuts(orderedIds);
  }
  async function onReset() {
    const ok = await confirmDialog.ask({
      title: t("shortcuts.resetConfirmTitle"),
      message: t("shortcuts.resetConfirmMessage"),
      confirmLabel: t("common.reset"),
      danger: true,
    });
    if (!ok) return;
    await settings.resetShortcutsToPresets();
  }

  // The swatches live in app.css (--color-icon-*), plus the palette's own two
  // text colours: "#a1a1aa" and "#fafafa" were --color-muted-foreground and
  // --color-foreground written out by hand.
  //
  // Resolved to hex here rather than stored as var() strings, because the chosen
  // value is persisted per shortcut and shown in the swatch's own tooltip: a
  // token reference in the settings file would not match the hex already saved
  // by earlier versions, and the picker would lose its "selected" ring.
  const ICON_COLOR_TOKENS = [
    "--color-icon-rust",
    "--color-icon-red",
    "--color-icon-amber",
    "--color-icon-yellow",
    "--color-icon-green",
    "--color-icon-teal",
    "--color-icon-blue",
    "--color-icon-indigo",
    "--color-icon-purple",
    "--color-icon-pink",
    "--color-muted-foreground",
    "--color-foreground",
  ];
  let iconColors = $state<string[]>([]);

  let colorPickerFor = $state<string | null>(null);
  let colorPopoverEl = $state<HTMLElement | null>(null);

  function setIconColor(id: string, color: string | null) {
    colorPickerFor = null;
    onUpdate(id, { iconColor: color });
  }

  /**
   * The popover closes the way every other floating surface in the app closes:
   * Escape through the shared stack, and a pointer landing anywhere else. It
   * used to be dismissed only by picking a colour, so tabbing away or opening
   * something else left it hanging over the rows below.
   */
  $effect(() => {
    if (!colorPickerFor) return;
    const previous = document.activeElement as HTMLElement | null;
    const release = registerEscape(() => (colorPickerFor = null));
    // Capture phase: the swatches stop their own click, and a pointerdown on the
    // trigger has to reach the trigger so it can toggle rather than reopen.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || colorPopoverEl?.contains(target)) return;
      if ((target as HTMLElement).closest?.("[data-color-trigger]")) return;
      colorPickerFor = null;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      release();
      window.removeEventListener("pointerdown", onPointerDown, true);
      restoreFocus(previous, colorPopoverEl);
    };
  });

  // Detection runs where the shortcuts will run. On a remote boite that is the
  // server, so naming it beats claiming "this computer".
  const detectionTarget = $derived(
    workspace.mode === "remote"
      ? (workspace.info.name ?? "boite")
      : t("shortcuts.detectionTargetLocal"),
  );

  onMount(() => {
    void cliDetection.ensure();
    const style = getComputedStyle(document.documentElement);
    iconColors = ICON_COLOR_TOKENS.map((name) =>
      style.getPropertyValue(name).trim(),
    ).filter(Boolean);
  });

  // Pointer-driven reorder, same mechanism as the thread sidebar: the drag
  // starts anywhere on the row and activates only after a 5px move, so plain
  // clicks on the inputs still work.
  //
  // The preview is transform-only: the DOM order never changes mid-drag, the
  // grabbed row follows the pointer and the rows it crosses slide one slot out
  // of its way. Committing then swaps the DOM into the order already on screen,
  // with the transforms dropped in the same update — so there is nothing to
  // animate back and no flash.
  //
  // Outside a drag the rows carry no transform at all: a permanent
  // translateY(0) makes every row its own stacking context, which traps the
  // color popup below the rows that follow it.
  type DragState = {
    id: string;
    pointerId: number;
    fromIndex: number;
    toIndex: number;
    startX: number;
    startY: number;
    dy: number;
    rowHeight: number;
    /** Row centers captured at grab time; transforms never move them. */
    centers: number[];
    active: boolean;
  };
  let listEl = $state<HTMLDivElement | null>(null);
  let drag = $state<DragState | null>(null);
  let dragCaptureEl: HTMLElement | null = null;

  // don't start a drag from an interactive control inside the row
  function isDragBlocked(el: HTMLElement | null): boolean {
    const hit = el?.closest("input, button, textarea, select, a");
    // The grip is one of those controls now, and it is the one control whose
    // whole job is to start the drag, so the blanket veto cannot apply to it.
    return !!hit && !hit.hasAttribute("data-grip");
  }

  function rowPointerDown(id: string, index: number, event: PointerEvent) {
    if (event.button !== 0 || isDragBlocked(event.target as HTMLElement)) return;
    const rows = Array.from(listEl?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    const rects = rows.map((row) => row.getBoundingClientRect());
    if (rects.length === 0) return;
    dragCaptureEl = event.currentTarget as HTMLElement;
    drag = {
      id,
      pointerId: event.pointerId,
      fromIndex: index,
      toIndex: index,
      startX: event.clientX,
      startY: event.clientY,
      dy: 0,
      rowHeight: rects[index].height,
      centers: rects.map((r) => r.top + r.height / 2),
      active: false,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
  }

  function targetIndex(d: DragState): number {
    const center = d.centers[d.fromIndex] + d.dy;
    let to = d.fromIndex;
    for (let i = d.fromIndex + 1; i < d.centers.length; i++) {
      if (center > d.centers[i]) to = i;
    }
    for (let i = d.fromIndex - 1; i >= 0; i--) {
      if (center < d.centers[i]) to = i;
    }
    return to;
  }

  function onDragMove(event: PointerEvent) {
    const d = drag;
    if (!d || event.pointerId !== d.pointerId) return;
    if (!d.active) {
      const moved = Math.hypot(event.clientX - d.startX, event.clientY - d.startY);
      if (moved < 5) return;
      d.active = true;
      try {
        dragCaptureEl?.setPointerCapture(d.pointerId);
      } catch {
        // pointer already released
      }
    }
    event.preventDefault();
    // Clamped to the list's own span: the row can never be dragged out of the
    // card, which is what the rounded overflow-hidden container would clip.
    const raw = event.clientY - d.startY;
    const up = -d.fromIndex * d.rowHeight;
    const down = (d.centers.length - 1 - d.fromIndex) * d.rowHeight;
    d.dy = Math.max(up, Math.min(down, raw));
    d.toIndex = targetIndex(d);
    drag = { ...d };
  }

  function onDragEnd() {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    const d = drag;
    dragCaptureEl = null;
    drag = null;
    if (!d || !d.active || d.toIndex === d.fromIndex) return;
    moveTo(d.fromIndex, d.toIndex);
  }

  function moveTo(from: number, to: number) {
    const ids = shortcuts.map((s) => s.id);
    if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) return;
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    onReorder(ids);
  }

  /**
   * The keyboard half of the reorder, on a control that says what it is.
   *
   * The grip was a span wearing role="button" whose only handler was the arrow
   * keys: it announced as a button, so Enter and Space were the two keys anyone
   * would try, and both did nothing. As a real toggle button, activating it
   * grabs the row the way pressing the pointer down on it does, arrows move it
   * either way, and Escape puts it back down.
   */
  let grabbedId = $state<string | null>(null);
  // Read aloud after a move: the rows swap silently, and the one that moved is
  // no longer where the reader last was. Position rather than a sentence, so it
  // needs no translation of its own.
  let reorderStatus = $state("");

  function gripKeydown(shortcut: Shortcut, index: number, event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      // Both would otherwise reach the button's own activation and, for Space,
      // scroll the settings pane.
      event.preventDefault();
      grabbedId = grabbedId === shortcut.id ? null : shortcut.id;
      return;
    }
    if (event.key === "Escape" && grabbedId === shortcut.id) {
      grabbedId = null;
      return;
    }
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const to = index + delta;
    if (to < 0 || to >= shortcuts.length) return;
    moveTo(index, to);
    // Carrying it is what an arrow press means, whether or not it was grabbed
    // first, so the row that is moving looks moved either way.
    grabbedId = shortcut.id;
    reorderStatus = t("shortcuts.movedTo", {
      label: shortcut.label,
      index: to + 1,
      total: shortcuts.length,
    });
  }

  function rowOffset(index: number): number {
    const d = drag;
    if (!d || !d.active) return 0;
    if (index === d.fromIndex) return d.dy;
    if (d.fromIndex < d.toIndex && index > d.fromIndex && index <= d.toIndex) {
      return -d.rowHeight;
    }
    if (d.toIndex < d.fromIndex && index >= d.toIndex && index < d.fromIndex) {
      return d.rowHeight;
    }
    return 0;
  }

  function addPreset(presetId: string) {
    const preset = CLI_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    onAdd({
      label: preset.label,
      command: preset.command,
      iconKey: preset.iconKey as IconKey,
    });
  }

  function presetAlreadyAdded(presetId: string): boolean {
    const preset = CLI_PRESETS.find((p) => p.id === presetId);
    if (!preset) return false;
    return shortcuts.some((s) => s.label === preset.label && s.command === preset.command);
  }
</script>

<div class="flex items-center justify-end gap-1.5">
  <button
    type="button"
    class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
    onclick={() => void onReset()}
    title={t("shortcuts.resetTitle")}
  >
    <RotateCcw class="size-3" />
    {t("common.reset")}
  </button>
  <button
    type="button"
    class="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition hover:bg-foreground/90"
    onclick={() => onAdd({ label: t("shortcuts.newShortcut"), command: "" })}
  >
    <Plus class="size-3" />
    {t("shortcuts.new")}
  </button>
</div>

<div
  bind:this={listEl}
  class="mt-2 rounded-lg border border-border bg-[var(--color-surface-2)]"
>
  {#if shortcuts.length === 0}
    <p class="px-4 py-6 text-center text-xs text-muted-foreground">
      {t("shortcuts.noShortcuts")}
    </p>
  {/if}
  {#each shortcuts as shortcut, i (shortcut.id)}
    {@const isDragged = drag?.active && drag.fromIndex === i}
    {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
    <div
      data-row={shortcut.id}
      role="listitem"
      onpointerdown={(e) => rowPointerDown(shortcut.id, i, e)}
      style:transform={drag ? `translateY(${rowOffset(i)}px)` : undefined}
      style:z-index={isDragged ? 10 : colorPickerFor === shortcut.id ? 20 : undefined}
      class="relative grid grid-cols-[16px_24px_120px_1fr_28px] touch-none items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0 {drag?.active
        ? 'select-none'
        : ''} {drag && drag.fromIndex !== i
        ? 'row-slide'
        : 'row-grabbed'} {isDragged || grabbedId === shortcut.id
        ? 'rounded-md border-transparent bg-[var(--color-surface-3)] shadow-lg ring-1 ring-foreground/15'
        : ''}"
    >
      <button
        type="button"
        data-grip
        class="flex size-4 cursor-grab items-center justify-center rounded transition hover:text-muted-foreground focus-visible:text-foreground active:cursor-grabbing {grabbedId ===
        shortcut.id
          ? 'text-foreground'
          : 'text-muted-foreground/40'}"
        aria-label={t("shortcuts.dragToReorder")}
        aria-pressed={grabbedId === shortcut.id}
        aria-keyshortcuts="ArrowUp ArrowDown"
        title={t("shortcuts.reorderHint")}
        onkeydown={(e) => gripKeydown(shortcut, i, e)}
        onblur={() => {
          if (grabbedId === shortcut.id) grabbedId = null;
        }}
      >
        <GripVertical class="size-3" />
      </button>
      <!-- focusout closes what a pointer leaving cannot: tabbing out of the last
           swatch used to leave the popover open over the rows below. -->
      <div
        class="relative flex size-6 items-center justify-center"
        onfocusout={(e) => {
          if (colorPickerFor !== shortcut.id) return;
          const next = e.relatedTarget as Node | null;
          if (next && e.currentTarget.contains(next)) return;
          colorPickerFor = null;
        }}
      >
        <button
          type="button"
          data-color-trigger
          class="flex size-6 items-center justify-center rounded-md border border-transparent transition hover:border-border hover:bg-[var(--color-surface-3)]"
          onclick={() => (colorPickerFor = colorPickerFor === shortcut.id ? null : shortcut.id)}
          aria-label={t("shortcuts.changeIconColor")}
          aria-expanded={colorPickerFor === shortcut.id}
          title={t("shortcuts.changeIconColor")}
        >
          <ShortcutIcon {iconKey} size={16} color={shortcut.iconColor ?? null} />
        </button>
        {#if colorPickerFor === shortcut.id}
          <div
            bind:this={colorPopoverEl}
            class="surface-popover absolute left-0 top-7 z-[var(--z-popover)] w-max p-2"
          >
            <div class="grid grid-cols-6 gap-1">
              {#each iconColors as c (c)}
                <button
                  type="button"
                  class="size-5 rounded-md border transition hover:scale-110 {shortcut.iconColor ===
                  c
                    ? 'border-foreground'
                    : 'border-border/60'}"
                  style:background-color={c}
                  onclick={() => setIconColor(shortcut.id, c)}
                  aria-label={t("shortcuts.setColor", { color: c })}
                  title={c}
                ></button>
              {/each}
            </div>
            <button
              type="button"
              class="mt-2 w-full rounded-md border border-border px-2 py-1 text-2xs text-muted-foreground transition hover:text-foreground"
              onclick={() => setIconColor(shortcut.id, null)}
            >
              {t("shortcuts.defaultColor")}
            </button>
          </div>
        {/if}
      </div>
      <input
        type="text"
        value={shortcut.label}
        placeholder={t("shortcuts.labelPlaceholder")}
        onchange={(e) =>
          onUpdate(shortcut.id, { label: (e.currentTarget as HTMLInputElement).value })}
        class="rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-foreground outline-none transition focus:border-border focus:bg-[var(--color-surface)]"
      />
      <input
        type="text"
        value={shortcut.command}
        placeholder={t("shortcuts.commandPlaceholder")}
        onchange={(e) =>
          onUpdate(shortcut.id, { command: (e.currentTarget as HTMLInputElement).value })}
        class="rounded-md border border-transparent bg-transparent px-2 py-1 font-mono text-sm text-foreground outline-none transition focus:border-border focus:bg-[var(--color-surface)]"
      />
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-danger/15 hover:text-danger"
        onclick={() => void onRemove(shortcut)}
        aria-label={t("shortcuts.removeShortcut")}
        title={t("shortcuts.remove")}
      >
        <Trash2 class="size-3" />
      </button>
    </div>
  {/each}
</div>

<p class="sr-only" role="status" aria-live="polite">{reorderStatus}</p>

<div class="mt-4 border-t border-border/40 pt-4">
  <div class="mb-3 flex items-end justify-between gap-3">
    <p class="text-2xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {t("shortcuts.addFromPreset")}
    </p>
    <button
      type="button"
      onclick={() => void cliDetection.refreshAll()}
      disabled={cliDetection.checking}
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
    >
      <RefreshCw class="size-3 {cliDetection.checking ? 'animate-spin' : ''}" />
      {cliDetection.checking ? t("shortcuts.checking") : t("shortcuts.recheck")}
    </button>
  </div>
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
    {#each CLI_PRESETS as preset (preset.id)}
      {@const added = presetAlreadyAdded(preset.id)}
      {@const installed = cliDetection.found[preset.executable] ?? false}
      <div
        class="flex items-center justify-between gap-2 rounded-lg border border-border/80 bg-[var(--color-surface-2)] p-2.5 transition hover:border-foreground/20 {added
          ? 'opacity-50'
          : ''}"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <div
            class="flex size-7 shrink-0 items-center justify-center rounded border border-border/40 bg-[var(--color-surface)]"
          >
            <ShortcutIcon iconKey={(preset.iconKey as IconKey) ?? null} size={14} />
          </div>
          <div class="flex min-w-0 flex-col">
            <span class="truncate text-xs font-semibold text-foreground">{preset.label}</span>
            {#if cliDetection.probed}
              <span
                class="mt-0.5 flex items-center gap-1 text-2xs {installed
                  ? 'text-[var(--color-success)]'
                  : 'text-muted-foreground/70'}"
              >
                <span
                  class="size-1.5 shrink-0 rounded-full {installed
                    ? 'bg-[var(--color-success)]'
                    : 'bg-muted-foreground/40'}"
                ></span>
                <span class="truncate">
                  {installed
                    ? t("shortcuts.detected", { target: detectionTarget })
                    : t("shortcuts.notDetected")}
                </span>
              </span>
            {:else}
              <span class="mt-0.5 truncate text-2xs text-muted-foreground/70">
                {preset.command}
              </span>
            {/if}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          {#if preset.docUrl}
            <a
              href={preset.docUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="flex size-7 cursor-pointer items-center justify-center rounded-md border border-border/60 bg-[var(--color-surface-3)] text-muted-foreground transition hover:bg-[var(--color-surface)] hover:text-foreground"
              title={t("shortcuts.documentation")}
              aria-label={t("shortcuts.documentation")}
            >
              <ExternalLink class="size-3.5" />
            </a>
          {/if}
          <button
            type="button"
            disabled={added}
            onclick={() => addPreset(preset.id)}
            class="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-foreground px-2.5 text-xs font-semibold text-background transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:border disabled:border-border/60 disabled:bg-transparent disabled:text-muted-foreground/60"
            title={added ? t("shortcuts.alreadyAdded") : t("shortcuts.addToShortcuts")}
          >
            {#if added}
              <Check class="size-3" />
            {:else}
              <Plus class="size-3" />
            {/if}
            <span>{added ? t("shortcuts.added") : t("shortcuts.add")}</span>
          </button>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  /* Only the rows the grabbed one crosses animate; the grabbed row tracks the
     pointer 1:1. Both are transforms, so the reduced-motion gate in app.css
     flattens the slide without touching the drag itself. */
  .row-slide {
    transition: transform 180ms cubic-bezier(0.2, 0, 0, 1);
  }
  .row-grabbed {
    transition: none;
  }
</style>
