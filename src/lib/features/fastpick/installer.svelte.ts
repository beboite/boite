import { PtyInstaller } from "$lib/shared/services/installer.svelte";
import { installCommand, uninstallCommand, updateCommand } from "./install";
import { fastpick } from "./store.svelte";

/**
 * Installing fastpick without leaving the settings panel.
 *
 * The machine is `PtyInstaller`: a hidden PTY, a log the panel draws, a stop
 * button. What is fastpick's own is the three command lines and who to tell
 * once a run has settled.
 *
 * Only the first install is a compiler. `update` hands the job to fastpick,
 * which fetches a signed release, so it is seconds and needs no toolchain.
 */
export const installer = new PtyInstaller({
  name: "fastpick",
  scope: "fastpick",
  commands: { install: installCommand, update: updateCommand, uninstall: uninstallCommand },
  settled: () => void fastpick.probe(),
});

export type { InstallAction, InstallStatus } from "$lib/shared/services/installer.svelte";
