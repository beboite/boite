<script lang="ts">
  import { settings, PRESET_SHORTCUTS } from "$lib/settings.svelte";
  import { app } from "$lib/store.svelte";
  import X from "@lucide/svelte/icons/x";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";

  function close() {
    app.view = "terminal";
  }

  function addCustom() {
    void settings.addShortcut({ label: "New shortcut", command: "" });
  }

  function addPreset(presetId: string) {
    const preset = PRESET_SHORTCUTS.find((p) => p.id === presetId);
    if (!preset) return;
    void settings.addShortcut({ label: preset.label, command: preset.command });
  }

  function removeShortcut(id: string) {
    void settings.removeShortcut(id);
  }

  function resetShortcuts() {
    void settings.resetShortcutsToPresets();
  }

  function togglePowershell(e: Event) {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    void settings.setPowershellNewline(checked);
  }

  function presetAlreadyAdded(presetId: string): boolean {
    const preset = PRESET_SHORTCUTS.find((p) => p.id === presetId);
    if (!preset) return false;
    return settings.state.shortcuts.some(
      (s) => s.label === preset.label && s.command === preset.command,
    );
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  <header
    class="flex shrink-0 items-center justify-between border-b border-border bg-[var(--color-surface)] px-5 py-3"
  >
    <h2 class="text-sm font-semibold tracking-tight">Settings</h2>
    <button
      type="button"
      class="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
      onclick={close}
      aria-label="Close settings"
      title="Back to terminal"
    >
      <X class="size-4" />
    </button>
  </header>

  <div class="flex-1 overflow-y-auto px-6 py-5">
    <div class="mx-auto max-w-3xl space-y-8">
      <section>
        <div class="mb-3 flex items-end justify-between gap-3">
          <div>
            <h3 class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Shortcuts
            </h3>
            <p class="mt-1 text-[12px] text-muted-foreground/80">
              Each shortcut launches a terminal in the selected project. Edit the command to
              pass arguments or use an alias.
            </p>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
              onclick={resetShortcuts}
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
          </div>
        </div>

        <div class="overflow-hidden rounded-lg border border-border bg-[var(--color-surface)]">
          {#if settings.state.shortcuts.length === 0}
            <p class="px-4 py-6 text-center text-xs text-muted-foreground">
              No shortcuts. Add one below or pick a preset.
            </p>
          {/if}
          {#each settings.state.shortcuts as shortcut (shortcut.id)}
            <div
              class="grid grid-cols-[16px_1fr_2fr_28px] items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0 hover:bg-accent/30"
            >
              <GripVertical class="size-3 text-muted-foreground/50" />
              <input
                type="text"
                value={shortcut.label}
                placeholder="Label"
                onchange={(e) =>
                  settings.updateShortcut(shortcut.id, {
                    label: (e.currentTarget as HTMLInputElement).value,
                  })}
                class="rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-foreground outline-none transition focus:border-border focus:bg-[var(--color-surface-2)]"
              />
              <input
                type="text"
                value={shortcut.command}
                placeholder="claude --resume"
                onchange={(e) =>
                  settings.updateShortcut(shortcut.id, {
                    command: (e.currentTarget as HTMLInputElement).value,
                  })}
                class="rounded-md border border-transparent bg-transparent px-2 py-1 font-mono text-[11.5px] text-foreground outline-none transition focus:border-border focus:bg-[var(--color-surface-2)]"
              />
              <button
                type="button"
                class="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-danger/15 hover:text-danger"
                onclick={() => removeShortcut(shortcut.id)}
                aria-label="Remove shortcut"
                title="Remove"
              >
                <Trash2 class="size-3" />
              </button>
            </div>
          {/each}
        </div>

        <div class="mt-3">
          <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Add from preset
          </p>
          <div class="flex flex-wrap gap-1.5">
            {#each PRESET_SHORTCUTS as preset (preset.id)}
              {@const added = presetAlreadyAdded(preset.id)}
              <button
                type="button"
                disabled={added}
                class="flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-surface)] px-2.5 py-1 text-[11px] transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-[var(--color-surface)]"
                onclick={() => addPreset(preset.id)}
              >
                <Plus class="size-3 opacity-60" />
                <span>{preset.label}</span>
                <span class="font-mono text-[10px] text-muted-foreground/70">
                  {preset.command}
                </span>
              </button>
            {/each}
          </div>
        </div>
      </section>

      <section class="border-t border-border pt-6">
        <h3 class="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Terminal
        </h3>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-[var(--color-surface)] p-3 transition hover:border-foreground/20"
        >
          <input
            type="checkbox"
            checked={settings.state.powershellNewline}
            onchange={togglePowershell}
            class="mt-0.5 size-3.5 shrink-0 accent-foreground"
          />
          <div class="flex-1">
            <div class="text-xs font-medium text-foreground">
              PowerShell newline translation
            </div>
            <div class="mt-0.5 text-[11px] text-muted-foreground">
              Shift+Enter sends LF (Ctrl+J) so PowerShell wraps a line without executing.
            </div>
          </div>
        </label>
      </section>
    </div>
  </div>
</div>
