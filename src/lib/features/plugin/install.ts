/** Published CLI: https://github.com/Pimpmuckl/codex-account-switcher */
export const CODEX_SWITCHER_REPO = "https://github.com/Pimpmuckl/codex-account-switcher";
export const CODEX_SWITCHER_CMD = "codex-account-switcher";

export function installCommand(): { cmd: string; args: string[] } {
  return {
    cmd: "cargo",
    args: ["install", "--git", CODEX_SWITCHER_REPO, "--locked"],
  };
}

export function updateCommand(): { cmd: string; args: string[] } {
  return {
    cmd: "cargo",
    args: ["install", "--git", CODEX_SWITCHER_REPO, "--locked", "--force"],
  };
}

export function uninstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["uninstall", "codex-account-switcher"] };
}
