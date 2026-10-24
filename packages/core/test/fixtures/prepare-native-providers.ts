/** Dedicated synthetic native lane dependencies. Never reads a CLI login or runs inference. */
import {appendFileSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Journal} from '../../src/journal.ts';
import {ProcRegistry} from '../../src/procs.ts';
import {Bus} from '../../src/bus.ts';

const root = resolve(process.argv[2] || join(tmpdir(), 'boite-synthetic-native-providers'));
mkdirSync(root, {recursive: true}); writeFileSync(join(root, 'package.json'), '{"private":true}');
const journal = new Journal(join(root, 'install.db')), procs = new ProcRegistry(journal, new Bus());
try {
  const child = procs.spawnPiped('fixture-native-install', process.execPath, ['add', '--exact', '--cwd', root,
    '@anthropic-ai/claude-code@2.1.310', '@openai/codex@0.164.0', 'opencode-ai@1.19.3', '@earendil-works/pi-coding-agent@1.4.0'], {agentRoot: false});
  child.proc.stdin.end();
  const [code, out, err] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
  if (code) throw new Error(`native fixture dependencies (${code}): ${out}${err}`);
  const wanted: Record<string, string> = {};
  const walk = (path: string, depth: number): void => {
    if (depth > 8) return;
    for (const entry of readdirSync(path, {withFileTypes: true})) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (['claude.exe', 'codex.exe', 'opencode.exe'].includes(entry.name)) wanted[`BOITE_TEST_${entry.name.slice(0, -4).toUpperCase()}_CLI`] = file;
    }
  };
  walk(join(root, 'node_modules'), 0);
  wanted['BOITE_TEST_PI_CLI'] = join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
  if (process.env['GITHUB_ENV']) appendFileSync(process.env['GITHUB_ENV'], `npm_config_prefix=${root}\n`);
  for (const name of ['CLAUDE', 'CODEX', 'OPENCODE', 'PI']) {
    const key = `BOITE_TEST_${name}_CLI`, value = wanted[key];
    if (!value) throw new Error(`native fixture: no installed ${name} executable`);
    if (process.env['GITHUB_ENV']) appendFileSync(process.env['GITHUB_ENV'], `${key}=${value}\n`);
    console.log(`${key}=${value}`);
  }
} finally {await procs.killAll(); await procs.close(); journal.close();}
