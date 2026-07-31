import { app } from "$lib/app/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import { launchAgent } from "$lib/features/thread/api";
import type { Thread } from "$lib/types";

/** Where fastpick is published. Boite installs from source; there is no other channel. */
export const FASTPICK_REPO = "https://github.com/beboite/fastpick";

/**
 * What installing fastpick actually is.
 *
 * `cargo install` rather than a downloaded binary, deliberately. It needs no asset naming
 * convention to guess and no signature story of boite's own, it puts the binary somewhere
 * already on the PATH, and it is the same command on the three platforms. The cost is a
 * Rust toolchain, which is checked before the button is offered.
 *
 * `--locked` builds against the lockfile fastpick ships rather than whatever resolves
 * today, so the install a user gets is the one that was tested.
 */
export function installCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["install", "--git", FASTPICK_REPO, "--locked"] };
}

/**
 * Removing the binary, and only the binary.
 *
 * `cargo uninstall` never touches a config directory, which is the point: fastpick's config
 * is where the endpoints and the key file paths are declared, and rebuilding that by hand
 * is the expensive part. Reinstalling picks it back up untouched.
 */
export function uninstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["uninstall", "fastpick"] };
}

/**
 * Runs one of them in a thread rather than behind a spinner.
 *
 * A `cargo install` is minutes of compiler output and it can fail in ways only its own
 * message explains. In a terminal the user watches it, reads the error, and can kill it.
 * On a remote boite the thread runs on the server, which is the machine that needs fastpick
 * in the first place.
 */
async function run(
  command: { cmd: string; args: string[] },
  label: string,
): Promise<Thread | null> {
  // Any project will do: this installs a binary, not something belonging to a repository.
  // The current one keeps it where the user was looking.
  const project =
    app.projects.find((p) => p.id === app.currentProjectId) ?? app.projects[0] ?? null;
  if (!project) {
    notifications.error(t("fastpick.addProjectFirst"));
    return null;
  }
  return launchAgent(project, { cmd: command.cmd, args: command.args, label, iconKey: null });
}

export function installFastpick(): Promise<Thread | null> {
  return run(installCommand(), "fastpick install");
}

export function uninstallFastpick(): Promise<Thread | null> {
  return run(uninstallCommand(), "fastpick uninstall");
}
