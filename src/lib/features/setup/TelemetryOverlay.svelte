<script lang="ts">
  import { backend } from "$lib/backend";
  import { restoreFocus } from "$lib/shared/keyboard/overlay";
  import TelemetryConsent from "./TelemetryConsent.svelte";
  import { reportSettingsSnapshot } from "./telemetry";

  type Props = {
    onDone: () => void;
  };
  let { onDone }: Props = $props();

  let dialogEl = $state<HTMLDivElement | null>(null);
  let busy = $state(false);

  $effect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const surface = dialogEl;
    dialogEl?.focus();
    return () => restoreFocus(previous, surface);
  });

  async function choose(modeB: boolean) {
    if (busy) return;
    busy = true;
    try {
      await backend().telemetry.completeOnboarding(true, modeB);
      void reportSettingsSnapshot();
      onDone();
    } catch {
      busy = false;
    }
  }
</script>

<div
  class="flex min-h-0 flex-1 items-center justify-center scroll-pane overflow-y-auto bg-[var(--color-background)] p-4"
>
  <div
    bind:this={dialogEl}
    class="surface-dialog deal-dialog flex w-[min(94vw,540px)] flex-col p-5 outline-none"
    role="dialog"
    aria-modal="true"
    aria-labelledby="telemetry-overlay-title"
    tabindex="-1"
  >
    <TelemetryConsent onChoose={choose} {busy} headingId="telemetry-overlay-title" />
  </div>
</div>

<style>
  .deal-dialog {
    max-height: min(92vh, 660px);
    overflow: hidden;
    gap: 12px;
  }
  @media (max-height: 520px) {
    .deal-dialog {
      overflow-y: auto;
    }
  }
</style>
