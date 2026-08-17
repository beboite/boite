<script lang="ts">
  import FastpickSettingsCard from "./FastpickSettingsCard.svelte";
  import PluginSlotCard from "$lib/features/plugin/PluginSlotCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { PLUGINS } from "$lib/features/plugin/spec";
  import { t } from "$lib/i18n/index.svelte";

  const claude = PLUGINS.find((plugin) => plugin.id === "claude-switcher")!;
  const codex = PLUGINS.find((plugin) => plugin.id === "codex-switcher")!;
</script>

<FastpickSettingsCard anchor="fastpick.settingsTitle" />
<ToggleSetting
  label={t("fastpick.enable")}
  anchor="fastpick.enable"
  description={t("fastpick.enableDesc")}
  enabled={settings.state.fastpickEnabled}
  onToggle={() => settings.setFastpickEnabled(!settings.state.fastpickEnabled)}
/>
<PluginSlotCard spec={claude} anchor="plugin.claudeTitle" />
<PluginSlotCard spec={codex} anchor="plugin.codexTitle" />
