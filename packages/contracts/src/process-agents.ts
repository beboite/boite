import type { NativeAgent, ProcessRecord } from './index.ts';

const names: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'pi', grok: 'Grok', agy: 'agy' };
const base = (path: string) => path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase().replace(/\.(exe|cmd|ps1)$/, '') ?? '';
const optionOperands = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--preload', '--env-file', '--env-file-if-exists', '--cwd', '-c', '--config']);

/** Read CLI metadata, never a prompt or arbitrary text from the command's output. */
export function processAgentCommand(record: Pick<ProcessRecord, 'exe' | 'commandLine'>): { name: string; model?: string; effort?: string } | null {
  if (!record.commandLine) return null;
  const words = Array.from(record.commandLine.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), match => match[1] ?? match[2] ?? match[3]!);
  let command = base(record.exe);
  let args = words.slice(1);
  if (command === 'node' || command === 'bun') {
    let script = 0;
    for (; script < args.length; script++) {
      const arg = args[script]!;
      if (arg === '--') { script++; break; }
      if (!arg.startsWith('-')) break;
      if (['-e', '--eval', '-p', '--print'].includes(arg.split('=')[0]!) || (command === 'node' && ['-c', '--check'].includes(arg))) return null;
      if (optionOperands.has(arg)) script++;
    }
    const path = args[script]?.replaceAll('\\', '/').toLowerCase() ?? '';
    const module = /\/(claude-code|codex|pi-coding-agent)\/(?:bin\/|dist\/)?(?:cli|codex)\.[cm]?js$/.exec(path)?.[1];
    if (!module) return null;
    command = module === 'claude-code' ? 'claude' : module === 'pi-coding-agent' ? 'pi' : module;
    args = args.slice(script + 1);
  }
  const name = Object.hasOwn(names, command) ? names[command] : undefined;
  if (!name) return null;
  // Probes, login, update and configuration processes do not do delegated work.
  if (args.some(arg => ['--version', '-v', '--help', '-h'].includes(arg))) return null;
  const work = command === 'codex' ? args.includes('exec') || args.includes('e')
    : command === 'opencode' ? args.includes('run') || args.includes('acp')
    : args.some(arg => ['--print', '-p', '--prompt', '--headless', '--input-format', '--mode'].includes(arg));
  if (!work) return null;
  const flag = (...flags: string[]): string | undefined => {
    for (const [index, arg] of args.entries()) {
      if (flags.includes(arg)) return args[index + 1]?.slice(0, 256);
      for (const key of flags) if (arg.startsWith(`${key}=`)) return arg.slice(key.length + 1, key.length + 257);
    }
    return undefined;
  };
  const effort = flag('--effort', '--thinking') ?? args.find(arg => arg.startsWith('model_reasoning_effort='))?.split('=')[1]?.replaceAll('"', '').replaceAll("'", '').slice(0, 64);
  return { name, model: flag('--model', '-m'), effort };
}

/** Only traced descendants count; the conversation's own CLI and nested CLI launchers do not. */
export function collectProcessAgents(records: ProcessRecord[], live: ProcessRecord[] = records): NativeAgent[] {
  const byPid = new Map(records.map(record => [`${record.threadId}:${record.pid}`, record]));
  const running = new Set(live.filter(record => record.exitedAt === null).map(record => `process:${record.threadId}:${record.pid}:${record.startedAt}`));
  return records.flatMap(record => {
    const command = processAgentCommand(record);
    if (!command || record.parentPid === null) return [];
    const parent = byPid.get(`${record.threadId}:${record.parentPid}`);
    if (!parent || parent.startedAt > record.startedAt || (parent.exitedAt !== null && parent.exitedAt < record.startedAt)) return [];
    if (processAgentCommand(parent)) return [];
    const id = `process:${record.threadId}:${record.pid}:${record.startedAt}`;
    return [{
      ...command, id, toolId: id, source: 'process', startedAt: record.startedAt,
      ...(record.exitedAt !== null ? { finishedAt: record.exitedAt } : {}),
      status: record.exitedAt === null ? running.has(id) ? 'running' : 'unknown' : record.exitCode === 0 ? 'done' : record.exitCode === null ? 'unknown' : 'error',
    } satisfies NativeAgent];
  });
}
