<script lang="ts">
  import type { MessageKey } from "$lib/i18n/index.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import SettingsCard from "$lib/shared/components/SettingsCard.svelte";
  import type { PluginSpec } from "./spec";

  let { spec, anchor }: { spec: PluginSpec; anchor: MessageKey } = $props();
</script>

<SettingsCard title={t(spec.titleKey)} {anchor} description={t(spec.descKey)}>
  <div class="flex items-center gap-2 text-xs">
    <span class="size-1.5 shrink-0 rounded-full" style:background-color="var(--color-border)"
    ></span>
    <span class="text-muted-foreground">{t("plugin.notInstalled")}</span>
  </div>
  <p class="text-xs leading-snug text-muted-foreground/80">{t("plugin.noPackage")}</p>
</SettingsCard>
