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
