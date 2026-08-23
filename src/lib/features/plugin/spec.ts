import type { MessageKey } from "$lib/i18n/messages";
import { FASTPICK_REPO } from "$lib/features/fastpick/install";
import { CODEX_SWITCHER_REPO } from "./install";
import { KEBACC_SWITCH_REPO } from "./install-kebacc";
import { FAST_MCP_SSH_REPO } from "./fast-mcp-ssh";

/**
 * A tool Boite can install from the plugins page, the way it already
 * installs fastpick. `repo` is the published source, never an invented name.
 */
export interface PluginSpec {
  id: string;
  titleKey: MessageKey;
  descKey: MessageKey;
  repo: string;
}

/**
 * What a card needs to know about the tool it draws, whoever is holding it.
 *
 * The stores answer more than this apiece; the shared card reads exactly these,
 * so a plugin that has nothing but a binary needs nothing but these.
 */
export interface PluginProbe {
  installed: boolean | null;
  version: string | null;
  cargoPresent: boolean | null;
  probing: boolean;
  error: string | null;
  probe(): Promise<void>;
}

export const PLUGINS: PluginSpec[] = [
  {
    id: "fastpick",
    titleKey: "fastpick.settingsTitle",
    descKey: "fastpick.settingsDesc",
    repo: FASTPICK_REPO,
  },
  {
    id: "kebacc-switch",
    titleKey: "plugin.kebaccTitle",
    descKey: "plugin.kebaccDesc",
    repo: KEBACC_SWITCH_REPO,
  },
  {
    id: "codex-account-switcher",
    titleKey: "plugin.codexTitle",
    descKey: "plugin.codexDesc",
    repo: CODEX_SWITCHER_REPO,
  },
  {
    id: "fast-mcp-ssh",
    titleKey: "plugin.fastMcpSshTitle",
    descKey: "plugin.fastMcpSshDesc",
    repo: FAST_MCP_SSH_REPO,
  },
];
