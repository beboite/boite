<script lang="ts">
  /**
   * Ask, edit alone, yolo, as one chip and the menu behind it.
   *
   * It used to be three segments sitting in the composer's bottom row, which
   * cost the width of three words to say one thing and had to be hidden below
   * the `sm` breakpoint to leave room for the send button. A chip says the mode
   * in force in the space of one word and keeps the other two one click away,
   * which is also what makes it reachable on a phone: the segmented version was
   * simply absent there and the mode could only be changed from the model menu.
   *
   * The one thing it is careful about is what the driver can actually honour:
   * a mode it does not map is disabled rather than hidden, so nobody learns
   * that a mode which exists elsewhere is missing here.
   *
   * The icon carries the meaning at a glance, the way the reference does it:
   * closed for a mode that asks, open for one that edits alone, and the bolt
   * for the one that asks nothing at all.
   */
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import type { PilotCapabilities, PilotExecMode } from "./types";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Lock from "@lucide/svelte/icons/lock";
  import LockOpen from "@lucide/svelte/icons/lock-open";
  import Zap from "@lucide/svelte/icons/zap";

  type Props = {
    threadId: string;
    mode: PilotExecMode;
    capabilities: PilotCapabilities | null;
    /** Which way the popover hangs off the chip. */
    placement?: "up" | "down";
  };
  let { threadId, mode, capabilities, placement = "up" }: Props = $props();

  let busy = $state(false);
  let open = $state(false);
  let trigger: HTMLButtonElement | null = $state(null);
  /** The chip and its menu together, so a click outside is one containment test. */
  let root: HTMLDivElement | null = $state(null);

  const MODES: {
    value: PilotExecMode;
    key: "pilot.modeAsk" | "pilot.modeEditAlone" | "pilot.modeYolo";
    hint: "pilot.modeAskDesc" | "pilot.modeEditAloneDesc" | "pilot.modeYoloDesc";
    icon: typeof Lock;
  }[] = [
    { value: "ask", key: "pilot.modeAsk", hint: "pilot.modeAskDesc", icon: Lock },
    {
      value: "edit_alone",
      key: "pilot.modeEditAlone",
      hint: "pilot.modeEditAloneDesc",
      icon: LockOpen,
    },
    { value: "yolo", key: "pilot.modeYolo", hint: "pilot.modeYoloDesc", icon: Zap },
  ];

  const current = $derived(MODES.find((row) => row.value === mode) ?? MODES[0]);
  /** Capitalised so the markup reads it as a component, the way `Timeline` does. */
  const CurrentIcon = $derived(current.icon);
  const allowed = (value: PilotExecMode): boolean =>
    capabilities ? capabilities.modes.includes(value) : true;

  function close(focusBack = true) {
    open = false;
    if (focusBack) trigger?.focus();
  }

  async function setMode(next: PilotExecMode) {
    if (busy) return;
    if (next === mode) {
      close();
      return;
    }
    busy = true;
    try {
      await backend().pilot.setMode(threadId, next);
      close();
    } catch (err) {
      log.warn("pilot.mode", "pilot.setMode.failed", { thread: threadId, reason: String(err) });
      notifications.error(t("pilot.switchFailed"));
    } finally {
      busy = false;
    }
  }

  // Escape closes this menu and nothing else: it is also the overlay stack's
  // key and the composer's interrupt, and a mode menu closing a pane's dialog
  // on its way out would be one keystroke doing two things.
  function onMenuKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (!open) return;
    const target = event.target as Node | null;
    if (target && !root?.contains(target)) close(false);
  }}
/>

<div class="relative" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    class="press flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-[var(--color-surface-2)] px-2.5 text-xs text-muted-foreground transition hover:border-edge hover:text-foreground focus:outline-none focus-visible:focus-ring"
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-haspopup="menu"
    aria-label={t("pilot.modeOpen")}
    title={t(current.hint)}
    data-testid="chat-mode-chip"
    data-mode={mode}
  >
    <CurrentIcon class="size-3 shrink-0" />
    <!-- The label is the half a narrow pane can drop: the icon and the caret
         still say which mode is on and that it can be changed. -->
    <span class="hidden font-medium sm:inline">{t(current.key)}</span>
    <ChevronDown class="size-3 shrink-0 opacity-70" />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="surface-popover pilot-pop absolute left-0 z-30 w-64 max-w-[calc(100vw-1.5rem)] p-1 {placement ===
      'up'
        ? 'bottom-full mb-1.5'
        : 'top-full mt-1.5'}"
      role="menu"
      tabindex="-1"
      aria-label={t("pilot.pickerMode")}
      onkeydown={onMenuKey}
      data-testid="chat-mode-menu"
    >
      {#each MODES as row (row.value)}
        {@const Icon = row.icon}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={row.value === mode}
          class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition focus:outline-none focus-visible:focus-ring-inset disabled:cursor-not-allowed disabled:opacity-50 {row.value ===
          mode
            ? 'bg-[var(--color-surface-3)] text-foreground'
            : 'text-muted-foreground hover:bg-[var(--color-surface-3)] hover:text-foreground'}"
          disabled={busy || !allowed(row.value)}
          onclick={() => void setMode(row.value)}
          data-testid="chat-mode"
          data-mode={row.value}
        >
          <Icon class="mt-0.5 size-3.5 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">{t(row.key)}</span>
            <span class="block text-xs text-muted-foreground">{t(row.hint)}</span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* 120ms, and nothing at all where the user asked for nothing: the app's own
     motion gate is an attribute on <html>, so a media query alone would ignore
     the setting in Appearance. */
  .pilot-pop {
    animation: pilot-pop var(--dur-2) var(--ease-out-quint);
  }
  @keyframes pilot-pop {
    from {
      opacity: 0;
      transform: translateY(-2px) scale(0.985);
    }
  }
  :global(html[data-motion="reduced"]) .pilot-pop {
    animation: none;
  }
</style>
