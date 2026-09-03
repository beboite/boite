<script lang="ts">
  import { backend } from "$lib/backend";
  import { focusTrap } from "$lib/shared/actions/focusTrap";
  import TelemetryConsent from "./TelemetryConsent.svelte";
  import { reportSettingsSnapshot } from "./telemetry";

  type Props = {
    onDone: () => void;
  };
  let { onDone }: Props = $props();

  let busy = $state(false);

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
    class="surface-dialog deal-dialog flex w-[min(94vw,540px)] flex-col p-5 outline-none"
    role="dialog"
    aria-modal="true"
    aria-labelledby="telemetry-overlay-title"
    tabindex="-1"
    use:focusTrap
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
