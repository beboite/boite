<script lang="ts">
  import FastpickSettingsCard from "./FastpickSettingsCard.svelte";
  import SwitcherCard from "$lib/features/plugin/SwitcherCard.svelte";
  import ToggleSetting from "$lib/shared/components/ToggleSetting.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { t } from "$lib/i18n/index.svelte";
</script>

<FastpickSettingsCard anchor="fastpick.settingsTitle" />
<ToggleSetting
  label={t("fastpick.enable")}
  anchor="fastpick.enable"
  description={t("fastpick.enableDesc")}
  enabled={settings.state.fastpickEnabled}
  onToggle={() => settings.setFastpickEnabled(!settings.state.fastpickEnabled)}
/>
<SwitcherCard kind="claude" anchor="plugin.claudeTitle" />
<SwitcherCard kind="codex" anchor="plugin.codexTitle" />
