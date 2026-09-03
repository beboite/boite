<!--
  The live agents card and the inbox, merged while both are empty.

  Two cards saying "Rien n'attend." one under the other is the audit's finding:
  the same sentence twice, in two headers, for zero rows. `HomePage` draws this
  instead, and gives each card back the moment either has something to show.
-->
<script lang="ts">
  import DashboardCard from "$lib/features/project/DashboardCard.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import Check from "@lucide/svelte/icons/check";
</script>

<DashboardCard title={t("home.nothingWaiting")}>
  {#snippet icon()}<Check class="size-3.5" />{/snippet}
  <p class="text-sm text-muted-foreground">{t("home.nothingWaitingDetail")}</p>
</DashboardCard>
