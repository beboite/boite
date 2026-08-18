import type { MessageKey } from "$lib/i18n/messages";
import { FASTPICK_REPO } from "$lib/features/fastpick/install";
import { CODEX_SWITCHER_REPO } from "./install";

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

export const PLUGINS: PluginSpec[] = [
  {
    id: "fastpick",
    titleKey: "fastpick.settingsTitle",
    descKey: "fastpick.settingsDesc",
    repo: FASTPICK_REPO,
  },
  {
    id: "codex-account-switcher",
    titleKey: "plugin.codexTitle",
    descKey: "plugin.codexDesc",
    repo: CODEX_SWITCHER_REPO,
  },
];
