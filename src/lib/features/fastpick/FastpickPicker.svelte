<script lang="ts">
  import { onMount } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { scale } from "svelte/transition";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { AnchoredMenu } from "$lib/shared/keyboard/anchoredMenu.svelte";
  import { fastpick } from "./store.svelte";
  import FastpickMenu from "./FastpickMenu.svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";

  /**
   * The fastpick button on the shortcut bar: a trigger, a floating box, and the
   * walk itself in `FastpickMenu`. The launcher popover shows that same walk
   * inline, which is why the two are separate files.
   */
  type Props = {
    /** See ShellPicker: the project a launch lands in, when one is named. */
    projectId?: string | null;
    onLaunched?: () => void;
  };
  let { projectId = null, onLaunched }: Props = $props();

  // Where it hangs, how it stays on screen, Escape and the click elsewhere.
  const menu = new AnchoredMenu();

  onMount(() => {
    // Probed once so the button can hide itself on a machine with no fastpick, rather
    // than offering a menu whose every entry fails. Turned off in the settings, nothing
    // is asked at all: the answer would only decide how to hide a button already hidden.
    if (settings.state.fastpickEnabled) void fastpick.ensure();
  });
</script>

{#if settings.state.fastpickEnabled && fastpick.installed !== false}
  <div bind:this={menu.trigger} class="relative flex shrink-0 items-stretch">
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:bg-[var(--color-surface-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      onclick={(e) => menu.toggle(e)}
      aria-haspopup="menu"
      aria-expanded={menu.open}
      use:tip={t("fastpick.tooltip")}
      aria-label={t("fastpick.tooltip")}
    >
      <!-- Same three parts as the Terminal button beside it: it launches a thread too, and
           a button with no glyph reads as smaller than its neighbours whatever its box says. -->
      <Plus class="size-3.5" />
      <span>{t("fastpick.label")}</span>
      <ChevronDown class="size-3.5" />
    </button>

    {#if menu.open}
      <div
        bind:this={menu.surface}
        class="surface-popover fixed z-[var(--z-popover)] flex max-h-[60vh] min-w-64 flex-col overflow-hidden"
        style:left="{menu.pos.x}px"
        style:top="{menu.pos.y}px"
        style:transform-origin="top left"
        transition:scale={{ duration: 90, start: 0.96 }}
      >
        <FastpickMenu
          {projectId}
          onLaunched={() => {
            menu.open = false;
            onLaunched?.();
          }}
          onResize={() => void menu.place()}
        />
      </div>
    {/if}
  </div>
{/if}
