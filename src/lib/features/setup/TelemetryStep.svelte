<script lang="ts">
  import type { SetupStepProps } from "./steps";
  import TelemetryConsent from "./TelemetryConsent.svelte";

  let { draft, onTelemetryChosen }: SetupStepProps = $props();

  function choose(modeB: boolean) {
    draft.modeB = modeB;
    onTelemetryChosen?.(modeB);
  }
</script>

<TelemetryConsent onChoose={choose} />
