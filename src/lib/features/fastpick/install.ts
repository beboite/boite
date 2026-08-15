/** Where fastpick is published: its releases, and the source the first install builds from. */
export const FASTPICK_REPO = "https://github.com/beboite/fastpick";

/**
 * The first install, when there is no fastpick to ask.
 *
 * `cargo install` rather than a downloaded binary, because nothing here yet knows where a
 * binary should go. Cargo answers that: `~/.cargo/bin` is already on the PATH, and it is the
 * same command on the three platforms. The cost is a Rust toolchain, which is checked before
 * the button is offered, and minutes of compiling.
 *
 * `--locked` builds against the lockfile fastpick ships rather than whatever resolves today,
 * so the install a user gets is the one that was tested.
 */
export function installCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["install", "--git", FASTPICK_REPO, "--locked"] };
}

/**
 * Updating, which is fastpick's own job rather than a second compile.
 *
 * `cargo install --git` builds `main` at whatever it points to, so an update meant minutes of
 * compiling for a commit carrying no version anybody published. `--update` fetches the newest
 * *release*, checks its minisign signature against the key compiled into the running binary,
 * and renames the new file over itself. So it needs no toolchain, no asset name guessed here
 * and no signature story of boite's own, and the version the panel reads afterwards is one
 * that was tagged.
 *
 * It exits 0 with `is the newest release` when there is nothing to do, which is why the panel
 * shows the log rather than only the verdict.
 */
export function updateCommand(): { cmd: string; args: string[] } {
  return { cmd: "fastpick", args: ["--update"] };
}

/**
 * Removing the binary, and only the binary.
 *
 * `cargo uninstall` never touches a config directory, which is the point: fastpick's config
 * is where the endpoints and the key file paths are declared, and rebuilding that by hand
 * is the expensive part. Reinstalling picks it back up untouched.
 *
 * Still cargo's, so it only removes what cargo put there. A fastpick that arrived some other
 * way is not this button's to delete.
 */
export function uninstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["uninstall", "fastpick"] };
}
