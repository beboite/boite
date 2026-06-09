import type { ShellOption } from "$lib/storage/platform.svelte";

function quoteArg(arg: string): string {
  if (!/[\s"']/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function buildCommandLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(quoteArg).join(" ");
}

interface SpawnPlan {
  cmd: string;
  args: string[];
  pendingInput: string | null;
}

export function planSpawnInShell(
  shell: ShellOption,
  userCmd: string,
  userArgs: string[],
): SpawnPlan {
  const cmdLine = buildCommandLine(userCmd, userArgs);
  return {
    cmd: shell.cmd,
    args: [...shell.args],
    pendingInput: cmdLine + "\r",
  };
}

export function planDirectSpawn(cmd: string, args: string[]): SpawnPlan {
  return { cmd, args, pendingInput: null };
}

const POWERSHELL_CMD = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?\s*$/i;

// PowerShell's slow start is banner + profile load. -NoLogo is free; the
// profile skip is opt-in since users may rely on aliases defined there.
export function withPowershellFastFlags(
  cmd: string,
  args: string[],
  noProfile: boolean,
): string[] {
  if (!POWERSHELL_CMD.test(cmd)) return args;
  const out = [...args];
  if (!out.some((a) => /^-nologo$/i.test(a))) out.unshift("-NoLogo");
  if (noProfile && !out.some((a) => /^-nop(?:rofile)?$/i.test(a))) {
    out.unshift("-NoProfile");
  }
  return out;
}
