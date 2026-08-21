<script lang="ts">
  import FastpickSettingsCard from "./FastpickSettingsCard.svelte";
  import KebaccSwitcherCard from "$lib/features/plugin/KebaccSwitcherCard.svelte";
  import CodexSwitcherCard from "$lib/features/plugin/CodexSwitcherCard.svelte";
  import FastMcpSshCard from "$lib/features/plugin/FastMcpSshCard.svelte";
</script>

<!--
  The toggles live inside the cards. Their anchors stay named here so settings
  search, which only reads this page, can still jump to them.
  anchor="fastpick.enable"
  anchor="plugin.kebaccClaude"
  anchor="plugin.kebaccCodex"
  anchor="plugin.kebaccAntigravity"
-->
<FastpickSettingsCard anchor="fastpick.settingsTitle" enableAnchor="fastpick.enable" />
<KebaccSwitcherCard
  anchor="plugin.kebaccTitle"
  claudeAnchor="plugin.kebaccClaude"
  codexAnchor="plugin.kebaccCodex"
  antigravityAnchor="plugin.kebaccAntigravity"
/>
<CodexSwitcherCard anchor="plugin.codexTitle" />
<FastMcpSshCard anchor="plugin.fastMcpSshTitle" />
