<script lang="ts">
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import { tip } from "$lib/shared/actions/tooltip";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { keybindings } from "./keybindings.svelte";
  import { comboFromEvent, formatCombo } from "$lib/shared/keyboard/combo";
  import {
    KEY_COMMANDS,
    KEY_COMMAND_BY_ID,
    KEY_COMMAND_GROUPS,
  } from "$lib/shared/keyboard/commands";
  import { isDeviceMacOS } from "$lib/storage/platform.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { t } from "$lib/i18n/index.svelte";

  /**
   * Every command Boite has, and what it answers to.
   *
   * Not to be confused with `ShortcutEditor.svelte` next to it: that one edits
   * the launcher buttons in the shortcut bar, which are command lines rather
   * than keys. The two share a word and nothing else.
   */

  const commandLabel = (id: string) => {
    const def = KEY_COMMAND_BY_ID[id];
    return def ? t(def.labelKey, def.labelParams) : id;
  };

  function startRecording(command: string) {
    keybindings.recording = command;
  }

  // Capture phase, and the dispatcher stands down while `recording` is set, so
  // the combo being recorded cannot also fire what it is currently bound to.
  $effect(() => {
    const command = keybindings.recording;
    if (!command) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const combo = comboFromEvent(event, isDeviceMacOS);
      if (!combo) return;
      keybindings.setKey(command, combo);
      keybindings.recording = null;
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  // A stale `recording` keeps the dispatcher suspended for the whole session,
  // so leaving the tab mid-recording must clear it.
  $effect(() => () => {
    keybindings.recording = null;
  });

  function resetAll() {
    keybindings.resetAll();
    keybindings.recording = null;
    notifications.success(t("keybindings.resetAllDone"));
  }

  const CHIP =
    "rounded-md border border-border bg-[var(--color-surface-2)] px-2 py-0.5 font-medium text-foreground";
</script>

<div class="flex items-start justify-between gap-3 px-3">
  <p class="text-sm text-muted-foreground">{t("keybindings.intro")}</p>
  <button
    type="button"
    class="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
    disabled={!keybindings.customized}
    onclick={resetAll}
  >
    {t("keybindings.resetAll")}
  </button>
</div>

{#each KEY_COMMAND_GROUPS as group (group.id)}
  <section class="flex flex-col">
    <h4
      class="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
    >
      {t(group.labelKey)}
    </h4>
    {#each KEY_COMMANDS.filter((c) => c.group === group.id) as command (command.id)}
      {@const rules = keybindings.byCommand[command.id] ?? []}
      {@const conflicts = keybindings.conflicts[command.id] ?? []}
      {@const recording = keybindings.recording === command.id}
      {@const shipped = keybindings.isDefault(command.id)}
      <div
        class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-1.5 hover:bg-[var(--color-surface-2)]"
      >
        <span class="min-w-0 flex-1 truncate text-sm">{commandLabel(command.id)}</span>

        {#if !shipped}
          <span class="text-[0.65rem] text-muted-foreground">{t("keybindings.changed")}</span>
        {/if}

        <button
          type="button"
          class="rounded-md border px-2 py-0.5 text-xs transition {recording
            ? 'border-foreground/50 bg-[var(--color-surface-3)] text-foreground'
            : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}"
          aria-label={t("keybindings.record")}
          onclick={() => (recording ? (keybindings.recording = null) : startRecording(command.id))}
        >
          {#if recording}
            {t("keybindings.recording")}
          {:else if rules.length === 0}
            <span class="italic">{t("keybindings.unbound")}</span>
          {:else}
            <span class="flex flex-wrap items-center gap-1">
              {#each rules as rule, i (rule.key + i)}
                <kbd class={CHIP}>{formatCombo(rule.key, isDeviceMacOS)}</kbd>
              {/each}
            </span>
          {/if}
        </button>

        {#if recording}
          <button
            type="button"
            class="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition hover:text-foreground"
            onclick={() => (keybindings.recording = null)}
          >
            {t("keybindings.recordCancel")}
          </button>
        {/if}

        <button
          type="button"
          class="rounded-md p-1 text-muted-foreground transition hover:text-foreground disabled:opacity-30"
          disabled={shipped}
          use:tip={t("keybindings.resetOne")}
          aria-label={t("keybindings.resetOne")}
          onclick={() => keybindings.reset(command.id)}
        >
          <RotateCcw class="size-3.5" />
        </button>

        {#if rules.length > 0}
          <span class="w-full pl-0 text-[0.65rem] text-muted-foreground">
            {rules[0].when
              ? t("keybindings.when", { clause: rules[0].when })
              : t("keybindings.whenAlways")}
          </span>
        {/if}

        {#each conflicts as conflict (conflict.other + conflict.key)}
          <span class="flex w-full items-center gap-1 text-[0.65rem] text-[var(--color-warning)]">
            <TriangleAlert class="size-3 shrink-0" />
            {conflict.shadowed
              ? t("keybindings.conflictShadowed", { other: commandLabel(conflict.other) })
              : t("keybindings.conflict", { other: commandLabel(conflict.other) })}
          </span>
        {/each}
      </div>
    {/each}
  </section>
{/each}
