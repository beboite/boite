/** Published CLI: https://github.com/kebab1337420/kebacc-switch */
export const KEBACC_SWITCH_REPO = "https://github.com/kebab1337420/kebacc-switch";
export const KEBACC_SWITCH_CMD = "kebacc-switch";

export function kebaccInstallCommand(): { cmd: string; args: string[] } {
  return {
    cmd: "cargo",
    args: ["install", "--git", KEBACC_SWITCH_REPO, "--locked"],
  };
}

export function kebaccUpdateCommand(): { cmd: string; args: string[] } {
  return {
    cmd: "cargo",
    args: ["install", "--git", KEBACC_SWITCH_REPO, "--locked", "--force"],
  };
}

export function kebaccUninstallCommand(): { cmd: string; args: string[] } {
  return { cmd: "cargo", args: ["uninstall", "kebacc-switch"] };
}
