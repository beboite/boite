import { PtyInstaller, type CommandSet } from "$lib/shared/services/installer.svelte";
import {
  installCommand as codexInstall,
  uninstallCommand as codexUninstall,
  updateCommand as codexUpdate,
} from "./install";
import {
  kebaccInstallCommand,
  kebaccUninstallCommand,
  kebaccUpdateCommand,
} from "./install-kebacc";
import {
  installCommand as sshInstall,
  uninstallCommand as sshUninstall,
  updateCommand as sshUpdate,
} from "./fast-mcp-ssh";
import { codexSwitcher, fastMcpSsh, kebaccSwitcher } from "./store.svelte";

/**
 * Installing a plugin's CLI without leaving the settings panel.
 *
 * The machine is `PtyInstaller`, shared with fastpick and with the CLI manager.
 * What is a plugin's own is its name, its three command lines and the store that
 * re-probes for the binary once a run has settled. Every action here is cargo,
 * install and update alike, so all three are builds and all three are watched
 * the same way.
 */

export type {
  InstallAction,
  InstallStatus,
  CommandSet,
} from "$lib/shared/services/installer.svelte";

/**
 * What PluginInstallCard reads. Named here because the card is a plugin
 * component; it is the same driver every installer offers.
 */
export type { InstallDriver as PluginInstallDriver } from "$lib/shared/services/installer.svelte";

export type PluginInstaller = PtyInstaller;

/**
 * One installer for a plugin, or for something that is not one of the three.
 *
 * The CLI manager needs the same machine for the agents that ship on a package
 * manager rather than as a binary, and their command lines come from the Rust
 * catalogue at runtime rather than from a module here. The class is what is
 * shared; the singletons below are not.
 */
export function makeInstaller(
  plugin: string,
  commands: CommandSet,
  settled: () => void,
): PluginInstaller {
  return new PtyInstaller({ name: plugin, scope: "plugin", commands, settled });
}

export const installer = makeInstaller(
  "codex-account-switcher",
  { install: codexInstall, update: codexUpdate, uninstall: codexUninstall },
  () => void codexSwitcher.probe(),
);

export const fastMcpSshInstaller = makeInstaller(
  "fast-mcp-ssh",
  { install: sshInstall, update: sshUpdate, uninstall: sshUninstall },
  () => void fastMcpSsh.probe(),
);

export const kebaccInstaller = makeInstaller(
  "kebacc-switch",
  {
    install: kebaccInstallCommand,
    update: kebaccUpdateCommand,
    uninstall: kebaccUninstallCommand,
  },
  () => void kebaccSwitcher.probe(),
);
