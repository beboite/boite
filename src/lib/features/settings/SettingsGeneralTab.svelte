<script lang="ts">
  import { settings, PRESET_SHORTCUTS } from "$lib/features/settings/store.svelte";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import UpdatesCard from "$lib/features/updater/UpdatesCard.svelte";
  import { hasTauri } from "$lib/backend/env";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import { t } from "$lib/i18n/index.svelte";

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
    void settings.updateShortcut(id, { iconColor: color });
  }

  // Pointer-driven reorder, same mechanism as the thread sidebar: drag starts
  // anywhere on the row, activates only after a 5px move (so plain clicks on the
  // inputs still work), and the pointer is captured on the row itself.
  let listEl = $state<HTMLDivElement | null>(null);
  let dragCaptureEl: HTMLElement | null = null;

  type DragState = {
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    y: number;
    active: boolean;
    slotIndex: number | null;
  };
  let drag = $state<DragState | null>(null);

  // where to draw the drop line: before a given row id, or after the last row
  const dropTarget = $derived.by<{ beforeId?: string; atEnd?: boolean } | null>(() => {
    const d = drag;
    if (!d || !d.active || d.slotIndex === null) return null;
    const reduced = settings.state.shortcuts.filter((s) => s.id !== d.id);
    if (d.slotIndex >= reduced.length) return { atEnd: true };
    return { beforeId: reduced[d.slotIndex].id };
  });

  // don't start a drag from an interactive control inside the row
  function isDragBlocked(el: HTMLElement | null): boolean {
    return !!el?.closest("input, button, textarea, select, a");
  }

  function rowElements(): HTMLElement[] {
    if (!listEl) return [];
    return Array.from(listEl.querySelectorAll<HTMLElement>("[data-row]"));
  }

  // reduced-list slot index in [0, n-1] the pointer targets (source excluded)
  function computeSlotIndex(d: DragState): number | null {
    const rows = rowElements().filter((el) => el.dataset.row !== d.id);
    if (rows.length === 0) return 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (d.y < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  function rowPointerDown(id: string, e: PointerEvent) {
    if (e.button !== 0 || isDragBlocked(e.target as HTMLElement)) return;
    dragCaptureEl = e.currentTarget as HTMLElement;
    drag = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      y: e.clientY,
      active: false,
      slotIndex: null,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
  }

  function onDragMove(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.y = e.clientY;
    if (!d.active) {
      const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (moved < 5) return;
      d.active = true;
      try {
        dragCaptureEl?.setPointerCapture(d.pointerId);
      } catch {
        // pointer already released
      }
    }
    e.preventDefault();
    d.slotIndex = computeSlotIndex(d);
    drag = { ...d };
  }

  function onDragEnd() {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    const d = drag;
    dragCaptureEl = null;
    drag = null;
    if (!d || !d.active || d.slotIndex === null) return;
    const ids = settings.state.shortcuts.map((s) => s.id);
    const fromIdx = ids.indexOf(d.id);
    if (fromIdx < 0) return;
    ids.splice(fromIdx, 1);
    const insertAt = Math.min(d.slotIndex, ids.length);
    if (insertAt === fromIdx) return;
    ids.splice(insertAt, 0, d.id);
    void settings.reorderShortcuts(ids);
  }

  function addCustom() {
    void settings.addShortcut({ label: "New shortcut", command: "" });
  }

  function addPreset(presetId: string) {
    const preset = PRESET_SHORTCUTS.find((p) => p.id === presetId);
    if (!preset) return;
    void settings.addShortcut({
      label: preset.label,
      command: preset.command,
      iconKey: preset.iconKey,
    });
  }

  function presetAlreadyAdded(presetId: string): boolean {
    const preset = PRESET_SHORTCUTS.find((p) => p.id === presetId);
    if (!preset) return false;
    return settings.state.shortcuts.some(
      (s) => s.label === preset.label && s.command === preset.command,
    );
  }

  // Nothing to update in a browser tab: the page is whatever the server last
  // served.
  const canUpdate = hasTauri();
</script>

{#if canUpdate}
  <UpdatesCard />
{/if}

<SettingsCard title={t("shortcuts.title")} description={t("shortcuts.description")}>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={() => settings.resetShortcutsToPresets()}
      title={t("shortcuts.resetTitle")}
    >
      <RotateCcw class="size-3" />
      {t("common.reset")}
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition hover:bg-foreground/90"
      onclick={addCustom}
    >
      <Plus class="size-3" />
      {t("shortcuts.new")}
    </button>
  {/snippet}

  <div
    bind:this={listEl}
    class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface-2)]"
  >
    {#if settings.state.shortcuts.length === 0}
      <p class="px-4 py-6 text-center text-xs text-muted-foreground">
        {t("shortcuts.noShortcuts")}
      </p>
    {/if}
    {#each settings.state.shortcuts as shortcut, i (shortcut.id)}
      {@const isDragged = drag?.active && drag.id === shortcut.id}
      {@const showTop = dropTarget?.beforeId === shortcut.id}
      {@const showBottom = dropTarget?.atEnd && i === settings.state.shortcuts.length - 1}
      {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
      <div
        data-row={shortcut.id}
        role="listitem"
        onpointerdown={(e) => rowPointerDown(shortcut.id, e)}
        class="grid grid-cols-[16px_24px_120px_1fr_28px] touch-none items-center gap-2 border-b border-border/60 px-3 py-2 transition last:border-b-0 {isDragged
          ? 'opacity-40'
          : ''} {showTop
          ? 'shadow-[inset_0_2px_0_0_var(--color-foreground)]'
          : ''} {showBottom ? 'shadow-[inset_0_-2px_0_0_var(--color-foreground)]' : ''}"
      >
        <span
          class="flex size-4 cursor-grab items-center justify-center text-muted-foreground/40 transition hover:text-muted-foreground active:cursor-grabbing"
          role="presentation"
          aria-label={t("shortcuts.dragToReorder")}
          title={t("shortcuts.dragToReorder")}
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
            settings.updateShortcut(shortcut.id, {
              label: (e.currentTarget as HTMLInputElement).value,
            })}
          class="rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-foreground outline-none transition focus:border-border focus:bg-[var(--color-surface)]"
        />
        <input
          type="text"
          value={shortcut.command}
          placeholder={t("shortcuts.commandPlaceholder")}
          onchange={(e) =>
            settings.updateShortcut(shortcut.id, {
              command: (e.currentTarget as HTMLInputElement).value,
            })}
          class="rounded-md border border-transparent bg-transparent px-2 py-1 font-mono text-[11.5px] text-foreground outline-none transition focus:border-border focus:bg-[var(--color-surface)]"
        />
        <button
          type="button"
          class="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-danger/15 hover:text-danger"
          onclick={() => settings.removeShortcut(shortcut.id)}
          aria-label={t("shortcuts.removeShortcut")}
          title={t("shortcuts.remove")}
        >
          <Trash2 class="size-3" />
        </button>
      </div>
    {/each}
  </div>

  <div>
    <p
      class="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
    >
      {t("shortcuts.addFromPreset")}
    </p>
    <div class="flex flex-wrap gap-1.5">
      {#each PRESET_SHORTCUTS as preset (preset.id)}
        {@const added = presetAlreadyAdded(preset.id)}
        <button
          type="button"
          disabled={added}
          class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1 text-[11px] transition hover:border-foreground/30 hover:bg-[var(--color-surface-3)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-[var(--color-surface-2)]"
          onclick={() => addPreset(preset.id)}
        >
          <ShortcutIcon iconKey={preset.iconKey ?? null} size={13} />
          <span>{preset.label}</span>
          <span class="font-mono text-[10px] text-muted-foreground/70">
            {preset.command}
          </span>
        </button>
      {/each}
    </div>
  </div>
</SettingsCard>
