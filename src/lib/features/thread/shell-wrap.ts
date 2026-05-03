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
