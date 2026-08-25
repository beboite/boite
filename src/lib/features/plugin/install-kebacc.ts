/** Published CLI: https://github.com/kebab1337420/kebacc-switch */
export const KEBACC_SWITCH_REPO = "https://github.com/kebab1337420/kebacc-switch";
/** The binary and the cargo package were both renamed in the CLI's 1.0.0. */
export const KEBACC_SWITCH_CMD = "kebacc";

export function kebaccInstallCommand(): { cmd: string; args: string[] } {
  return {
    cmd: "cargo",
    args: ["install", "--git", KEBACC_SWITCH_REPO, "--locked", KEBACC_SWITCH_CMD],
  };
}

export function kebaccUpdateCommand(): { cmd: string; args: string[] } {
  return {
    cmd: "cargo",
    args: ["install", "--git", KEBACC_SWITCH_REPO, "--locked", "--force", KEBACC_SWITCH_CMD],
  };
}

export function kebaccUninstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["uninstall", KEBACC_SWITCH_CMD] };
}
