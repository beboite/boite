<!--
  `fast-mcp-ssh`, installed and nothing more.

  There is no second half to this card. The server is launched by whichever
  agent declares it in its own MCP config, and its hosts file is that agent's
  to read: boite puts the binary on the machine and stops there.
-->
<script lang="ts">
  import { t, type MessageKey } from "$lib/i18n/index.svelte";
  import {
    FAST_MCP_SSH_REPO,
    installCommand,
    uninstallCommand,
    updateCommand,
  } from "./fast-mcp-ssh";
  import { fastMcpSshInstaller } from "./installer.svelte";
  import { fastMcpSsh } from "./store.svelte";
  import PluginInstallCard from "./PluginInstallCard.svelte";

  let { anchor }: { anchor: MessageKey } = $props();
</script>

<PluginInstallCard
  {anchor}
  title={t("plugin.fastMcpSshTitle")}
  description={t("plugin.fastMcpSshDesc")}
  repo={FAST_MCP_SSH_REPO}
  install={installCommand()}
  update={updateCommand()}
  uninstall={uninstallCommand()}
  probe={fastMcpSsh}
  installer={fastMcpSshInstaller}
/>
