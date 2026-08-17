import type { MessageKey } from "$lib/i18n/messages";
import { FASTPICK_REPO } from "$lib/features/fastpick/install";

/**
 * A tool Boite can install from the plugins page, the way it already
 * installs fastpick.
 *
 * `repo` is the published source. Without one the card is a slot: same
 * place, no install button that would run a command we invented.
 */
export interface PluginSpec {
  id: string;
  titleKey: MessageKey;
  descKey: MessageKey;
  repo: string | null;
}

export const PLUGINS: PluginSpec[] = [
  {
    id: "fastpick",
    titleKey: "fastpick.settingsTitle",
    descKey: "fastpick.settingsDesc",
    repo: FASTPICK_REPO,
  },
  {
    id: "claude-switcher",
    titleKey: "plugin.claudeTitle",
    descKey: "plugin.claudeDesc",
    repo: null,
  },
  {
    id: "codex-switcher",
    titleKey: "plugin.codexTitle",
    descKey: "plugin.codexDesc",
    repo: null,
  },
];

export function isInstallable(plugin: PluginSpec): plugin is PluginSpec & { repo: string } {
  return plugin.repo !== null;
}
