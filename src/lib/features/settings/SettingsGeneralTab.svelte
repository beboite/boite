<script lang="ts">
  import { settings } from "$lib/features/settings/store.svelte";
  import { CLI_PRESETS } from "$lib/features/settings/cliPresets";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import { resolveIconKey } from "$lib/shared/icons/detect";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import type { IconKey } from "$lib/types";

  let draggedId = $state<string | null>(null);
  let overId = $state<string | null>(null);
  let dragArmed = $state(false);

  function armDrag() {
    dragArmed = true;
  }
  function disarmDrag() {
    dragArmed = false;
  }

  function addCustom() {
    void settings.addShortcut({ label: "New shortcut", command: "" });
  }

  function addPreset(presetId: string) {
    const preset = CLI_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    void settings.addShortcut({
      label: preset.label,
      command: preset.command,
      iconKey: preset.iconKey as IconKey,
    });
  }

  function presetAlreadyAdded(presetId: string): boolean {
    const preset = CLI_PRESETS.find((p) => p.id === presetId);
    if (!preset) return false;
    return settings.state.shortcuts.some(
      (s) => s.label === preset.label && s.command === preset.command,
    );
  }

  function onDragStart(id: string, e: DragEvent) {
    if (!dragArmed) {
      e.preventDefault();
      return;
    }
    draggedId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    }
  }

  function onDragOver(id: string, e: DragEvent) {
    if (!draggedId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    overId = id;
  }

  function onDragLeave(id: string) {
    if (overId === id) overId = null;
  }

  function onDrop(targetId: string, e: DragEvent) {
    e.preventDefault();
    const from = draggedId;
    draggedId = null;
    overId = null;
    dragArmed = false;
    if (!from || from === targetId) return;
    const ids = settings.state.shortcuts.map((s) => s.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, from);
    void settings.reorderShortcuts(ids);
  }

  function onDragEnd() {
    draggedId = null;
    overId = null;
    dragArmed = false;
  }
</script>

<SettingsCard
  title="Shortcuts"
  description="Drag the grip to reorder. Edit the command to pass arguments or use an alias."
>
  {#snippet actions()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface-2)] px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      onclick={() => settings.resetShortcutsToPresets()}
      title="Reset to default presets"
    >
      <RotateCcw class="size-3" />
      Reset
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background transition hover:bg-foreground/90"
      onclick={addCustom}
    >
      <Plus class="size-3" />
      New
    </button>
  {/snippet}

  <div class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface-2)]">
    {#if settings.state.shortcuts.length === 0}
      <p class="px-4 py-6 text-center text-xs text-muted-foreground">
        No shortcuts. Add one or pick a preset below.
      </p>
    {/if}
    {#each settings.state.shortcuts as shortcut (shortcut.id)}
      {@const isDragged = draggedId === shortcut.id}
      {@const isOver = overId === shortcut.id && draggedId !== shortcut.id}
      {@const iconKey = resolveIconKey(shortcut.iconKey, shortcut.label, shortcut.command)}
      <div
        draggable={dragArmed}
        ondragstart={(e) => onDragStart(shortcut.id, e)}
        ondragover={(e) => onDragOver(shortcut.id, e)}
        ondragleave={() => onDragLeave(shortcut.id)}
        ondrop={(e) => onDrop(shortcut.id, e)}
        ondragend={onDragEnd}
        role="listitem"
        class="grid grid-cols-[16px_24px_120px_1fr_28px] items-center gap-2 border-b border-border/60 px-3 py-2 transition last:border-b-0 {isDragged
          ? 'opacity-40'
          : ''} {isOver ? 'border-t-2 border-t-foreground/40' : ''}"
      >
        <span
          class="flex size-4 cursor-grab items-center justify-center text-muted-foreground/40 transition hover:text-muted-foreground active:cursor-grabbing"
          onmousedown={armDrag}
          onmouseup={disarmDrag}
          onmouseleave={disarmDrag}
          role="button"
          tabindex="-1"
          aria-label="Drag to reorder"
          title="Drag to reorder"
        >
          <GripVertical class="size-3" />
        </span>
        <div class="flex size-6 items-center justify-center">
          <ShortcutIcon {iconKey} size={16} />
        </div>
        <input
          type="text"
          value={shortcut.label}
          placeholder="Label"
          onchange={(e) =>
            settings.updateShortcut(shortcut.id, {
              label: (e.currentTarget as HTMLInputElement).value,
            })}
          class="rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-foreground outline-none transition focus:border-border focus:bg-[var(--color-surface)]"
        />
        <input
          type="text"
          value={shortcut.command}
          placeholder="claude --resume"
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
          aria-label="Remove shortcut"
          title="Remove"
        >
          <Trash2 class="size-3" />
        </button>
      </div>
    {/each}
  </div>

  <div class="mt-4 border-t border-border/40 pt-4">
    <p
      class="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
    >
      Add from preset
    </p>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {#each CLI_PRESETS as preset (preset.id)}
        {@const added = presetAlreadyAdded(preset.id)}
        <div
          class="flex items-center justify-between rounded-lg border border-border/80 bg-[var(--color-surface-2)] p-2.5 transition hover:border-foreground/20 {added ? 'opacity-50' : ''}"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="flex size-7 items-center justify-center shrink-0 rounded bg-[var(--color-surface)] border border-border/40">
              <ShortcutIcon iconKey={preset.iconKey as IconKey ?? null} size={14} />
            </div>
            <div class="flex flex-col min-w-0">
              <span class="text-xs font-semibold text-foreground truncate">
                {preset.label}
              </span>
              <span class="font-mono text-[9.5px] text-muted-foreground/70 truncate mt-0.5">
                {preset.command}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            {#if preset.docUrl}
              <a
                href={preset.docUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="flex size-7 items-center justify-center rounded-md border border-border/60 bg-[var(--color-surface-3)] text-muted-foreground transition hover:bg-[var(--color-surface)] hover:text-foreground cursor-pointer"
                title="Documentation"
              >
                <ExternalLink class="size-3.5" />
              </a>
            {/if}
            <button
              type="button"
              disabled={added}
              onclick={() => addPreset(preset.id)}
              class="flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-[11px] font-semibold text-background transition hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-muted-foreground/60 disabled:border disabled:border-border/60 cursor-pointer"
              title={added ? "Already added" : "Add to shortcuts"}
            >
              <Plus class="size-3" />
              <span>{added ? "Ajouté" : "Ajouter"}</span>
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>
</SettingsCard>
