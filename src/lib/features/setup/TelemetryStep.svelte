<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import type { SetupStepProps } from "./steps";
  import TelemetryConsent from "./TelemetryConsent.svelte";

  let { draft, onTelemetryChosen }: SetupStepProps = $props();

  function choose(modeB: boolean) {
    draft.modeB = modeB;
    onTelemetryChosen?.(modeB);
  }
</script>

<h2 class="text-center text-lg font-bold text-foreground">{t("setup.telemetryTitle")}</h2>
<p class="text-center text-xs leading-relaxed text-muted-foreground">{t("setup.telemetryDesc")}</p>
<TelemetryConsent onChoose={choose} />
