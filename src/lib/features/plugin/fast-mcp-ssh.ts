/** Published CLI: https://github.com/klNuno/fast-mcp-ssh */
export const FAST_MCP_SSH_REPO = "https://github.com/klNuno/fast-mcp-ssh";
export const FAST_MCP_SSH_CMD = "fast-mcp-ssh";
/** The crate, which is what cargo is handed. Same string, named for what it is. */
export const FAST_MCP_SSH_CRATE = "fast-mcp-ssh";

/**
 * The install, from crates.io rather than from the repository.
 *
 * The other two plugins here are built with `--git` because that is where they
 * are published. This one has releases on crates.io, so cargo resolves a
 * version that was tagged instead of whatever `main` points at today, and the
 * user gets the same binary twice in a row.
 *
 * `--locked` builds against the lockfile the crate ships, so what installs is
 * what was tested.
 */
export function installCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["install", FAST_MCP_SSH_CRATE, "--locked"] };
}

/**
 * Updating, which is the same command again: cargo compares the installed
 * version against the newest on crates.io and says so when there is nothing to
 * do. `--force` because a reinstall of the same version is otherwise refused,
 * and a button that reports "already installed" as a failure is worse than a
 * few seconds of cargo deciding.
 */
export function updateCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["install", FAST_MCP_SSH_CRATE, "--locked", "--force"] };
}

/**
 * Removing the binary, and only the binary. `~/.fast-mcp-ssh/hosts.toml` is
 * where the machines are declared and rebuilding it by hand is the expensive
 * part, so cargo never touches it and neither does this.
 */
export function uninstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["uninstall", FAST_MCP_SSH_CRATE] };
}
