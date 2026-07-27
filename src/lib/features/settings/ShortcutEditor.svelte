<script lang="ts">
  import { onMount } from "svelte";
  import { workspace } from "$lib/backend";
  import { settings } from "./store.svelte";
  import { CLI_PRESETS } from "./cliPresets";
  import { cliDetection } from "./cliDetection.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { resolveIconKey } from "$lib/shared/icons/detect";
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
  function onRemove(id: string) {
    void settings.removeShortcut(id);
  }
  function onAdd(init: Partial<Shortcut>) {
    void settings.addShortcut(init);
  }
  function onReorder(orderedIds: string[]) {
    void settings.reorderShortcuts(orderedIds);
  }
  function onReset() {
    void settings.resetShortcutsToPresets();
  }

  // Distinguishable at 14–16px on the dark surfaces, which rules out anything
  // too dark or too desaturated.
  const ICON_COLORS = [
    "#d97757",
    "#e5484d",
    "#f5a524",
    "#f2e14c",
    "#46a758",
    "#2ec4b6",
    "#3b9eff",
    "#6e56cf",
    "#c04ad8",
    "#ff8fab",
    "#a1a1aa",
    "#fafafa",
  ];

  let colorPickerFor = $state<string | null>(null);

  function setIconColor(id: string, color: string | null) {
    colorPickerFor = null;
    onUpdate(id, { iconColor: color });
  }

  // Detection runs where the shortcuts will run. On a remote boite that is the
  // server, so naming it beats claiming "this computer".
  const detectionTarget = $derived(
    workspace.mode === "remote"
      ? (workspace.info.name ?? "boite")
      : t("shortcuts.detectionTargetLocal"),
  );

  onMount(() => {
    void cliDetection.ensure();
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
    return !!el?.closest("input, button, textarea, select, a");
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

  // The grip is a span, not a button, so the pointer drag still starts on it —
  // isDragBlocked would veto a real button. Arrow keys are the keyboard path to
  // the same reorder.
  function gripKeydown(index: number, event: KeyboardEvent) {
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const to = index + delta;
    if (to < 0 || to >= shortcuts.length) return;
    moveTo(index, to);
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
    onclick={onReset}
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
      style:transform="translateY({rowOffset(i)}px)"
      style:z-index={isDragged ? 10 : undefined}
      class="relative grid grid-cols-[16px_24px_120px_1fr_28px] touch-none items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0 {drag?.active
        ? 'select-none'
        : ''} {drag && drag.fromIndex !== i
        ? 'row-slide'
        : 'row-grabbed'} {isDragged
        ? 'rounded-md border-transparent bg-[var(--color-surface-3)] shadow-lg ring-1 ring-foreground/15'
        : ''}"
    >
      <span
        class="flex size-4 cursor-grab items-center justify-center rounded text-muted-foreground/40 transition hover:text-muted-foreground focus-visible:text-foreground active:cursor-grabbing"
        role="button"
        tabindex="0"
        aria-label={t("shortcuts.dragToReorder")}
        title={t("shortcuts.reorderHint")}
        onkeydown={(e) => gripKeydown(i, e)}
      >
        <GripVertical class="size-3" />
      </span>
      <div class="relative flex size-6 items-center justify-center">
        <button
          type="button"
          class="flex size-6 items-center justify-center rounded-md border border-transparent transition hover:border-border hover:bg-[var(--color-surface-3)]"
          onclick={() => (colorPickerFor = colorPickerFor === shortcut.id ? null : shortcut.id)}
          aria-label={t("shortcuts.changeIconColor")}
          title={t("shortcuts.changeIconColor")}
        >
          <ShortcutIcon {iconKey} size={16} color={shortcut.iconColor ?? null} />
        </button>
        {#if colorPickerFor === shortcut.id}
          <div
            class="absolute left-0 top-7 z-50 w-max rounded-lg border border-border bg-[var(--color-surface-3)] p-2 shadow-lg"
          >
            <div class="grid grid-cols-6 gap-1">
              {#each ICON_COLORS as c (c)}
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
              class="mt-2 w-full rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground transition hover:text-foreground"
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
        class="rounded-md border border-transparent bg-transparent px-2 py-1 font-mono text-[11.5px] text-foreground outline-none transition focus:border-border focus:bg-[var(--color-surface)]"
      />
      <button
        type="button"
        class="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-danger/15 hover:text-danger"
        onclick={() => onRemove(shortcut.id)}
        aria-label={t("shortcuts.removeShortcut")}
        title={t("shortcuts.remove")}
      >
        <Trash2 class="size-3" />
      </button>
    </div>
  {/each}
</div>

<div class="mt-4 border-t border-border/40 pt-4">
  <div class="mb-3 flex items-end justify-between gap-3">
    <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {t("shortcuts.addFromPreset")}
    </p>
    <button
      type="button"
      onclick={() => void cliDetection.refreshAll()}
      disabled={cliDetection.checking}
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-1 text-[10.5px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
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
                class="mt-0.5 flex items-center gap-1 text-[9.5px] {installed
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
              <span class="mt-0.5 truncate font-mono text-[9.5px] text-muted-foreground/70">
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
            class="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-foreground px-2.5 text-[11px] font-semibold text-background transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:border disabled:border-border/60 disabled:bg-transparent disabled:text-muted-foreground/60"
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
