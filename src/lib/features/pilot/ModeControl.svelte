<script lang="ts">
  /**
   * Ask, edit alone, yolo, as one segmented control.
   *
   * Its own file because it is drawn twice: in the composer's bottom row, where
   * it is the thing a user changes between two turns, and inside the model
   * menu, where it belongs beside the account. Two copies would drift on the
   * one thing that matters here, which modes the driver actually maps to
   * something native: a segment the driver cannot honour is disabled rather
   * than hidden, so nobody learns a mode that exists elsewhere is missing.
   *
   * `compact` is the composer's: the same three segments with the line under
   * them dropped, because the row already has the chip and the send button in
   * it and the sentence lives one click away in the menu.
   */
  import { backend } from "$lib/backend";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { log } from "$lib/shared/log";
  import { t } from "$lib/i18n/index.svelte";
  import type { PilotCapabilities, PilotExecMode } from "./types";

  type Props = {
    threadId: string;
    mode: PilotExecMode;
    capabilities: PilotCapabilities | null;
    compact?: boolean;
  };
  let { threadId, mode, capabilities, compact = false }: Props = $props();

  let busy = $state(false);

  const MODES: {
    value: PilotExecMode;
    key: "pilot.modeAsk" | "pilot.modeEditAlone" | "pilot.modeYolo";
    hint: "pilot.modeAskDesc" | "pilot.modeEditAloneDesc" | "pilot.modeYoloDesc";
  }[] = [
    { value: "ask", key: "pilot.modeAsk", hint: "pilot.modeAskDesc" },
    { value: "edit_alone", key: "pilot.modeEditAlone", hint: "pilot.modeEditAloneDesc" },
    { value: "yolo", key: "pilot.modeYolo", hint: "pilot.modeYoloDesc" },
  ];

  const current = $derived(MODES.find((row) => row.value === mode) ?? MODES[0]);

  async function setMode(next: PilotExecMode) {
    if (busy || next === mode) return;
    busy = true;
    try {
      await backend().pilot.setMode(threadId, next);
    } catch (err) {
      log.warn("pilot.mode", "pilot.setMode.failed", { thread: threadId, reason: String(err) });
      notifications.error(t("pilot.switchFailed"));
    } finally {
      busy = false;
    }
  }
</script>

<div class={compact ? "" : "w-full"}>
  <div
    class="flex gap-0.5 rounded-full bg-[var(--color-surface-2)] p-0.5 {compact
      ? ''
      : 'rounded-md bg-[var(--color-surface)]'}"
    role="group"
    aria-label={t("pilot.pickerMode")}
  >
    {#each MODES as row (row.value)}
      <button
        type="button"
        class="press rounded-full px-2 py-0.5 text-xs whitespace-nowrap transition focus:outline-none focus-visible:focus-ring-inset disabled:opacity-40 {compact
          ? ''
          : 'flex-1 rounded px-2 py-1 text-center'} {row.value === mode
          ? 'bg-[var(--color-surface-3)] text-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        disabled={busy || (capabilities ? !capabilities.modes.includes(row.value) : false)}
        onclick={() => void setMode(row.value)}
        title={t(row.hint)}
        aria-label="{t(row.key)} {t(row.hint)}"
        aria-pressed={row.value === mode}
        data-testid="chat-mode"
        data-mode={row.value}
      >
        {t(row.key)}
      </button>
    {/each}
  </div>
  {#if !compact}
    <p class="pt-1.5 text-xs text-muted-foreground">{t(current.hint)}</p>
  {/if}
</div>
