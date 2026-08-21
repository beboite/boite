<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
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
    class="surface-dialog flex w-[min(94vw,520px)] flex-col gap-4 p-6 outline-none"
    role="dialog"
    aria-modal="true"
    aria-labelledby="telemetry-overlay-title"
    tabindex="-1"
  >
    <h2 id="telemetry-overlay-title" class="text-center text-lg font-bold text-foreground">
      {t("setup.telemetryOverlayTitle")}
    </h2>
    <p class="text-center text-xs leading-relaxed text-muted-foreground">
      {t("setup.telemetryOverlayDesc")}
    </p>
    <TelemetryConsent onChoose={choose} {busy} />
  </div>
</div>
