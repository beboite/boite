/** Dedicated synthetic native lane dependencies. Never reads a CLI login or runs inference. */
import {appendFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {ProviderInstall} from '@boite/contracts';
import {Journal} from '../../src/journal.ts';
import {ProcRegistry} from '../../src/procs.ts';
import {Bus} from '../../src/bus.ts';
import museShipped from '../../src/providers/shipped/muse.json';
import {downloadArchive, dropPart, IDLE_TIMEOUT_MS} from '../../src/providers/install-download.ts';
import {checkSizes, extractRelease} from '../../src/providers/install-unpack.ts';

/** Reuse managed-install byte and digest checks, with no login, latest-release lookup or retries. */
export async function prepareWindowsMuse(root: string, install: ProviderInstall = museShipped.profiles.windows.install as ProviderInstall): Promise<string> {
  if (install.version !== '1.4.13-R6996.1' || install.format !== 'binary' || install.files.length !== 1 || install.files[0]?.path !== 'muse.exe') {
    throw new Error('native Muse fixture requires the pinned binary 1.4.13-R6996.1 with muse.exe');
  }
  const directory = join(root, 'muse'), part = join(root, 'muse.part');
  const signal = AbortSignal.timeout(180000);
  try {
    await downloadArchive({providerId: 'muse', install, operationId: 'fixture-native-muse', signal, part,
      idleTimeoutMs: IDLE_TIMEOUT_MS, retryDelaysMs: [], move() {}, log(_level, message) {console.log(message);}});
    await extractRelease(install, signal, part, directory, root);
    checkSizes(install, directory);
    const binary = join(directory, `muse-bin-${install.version}.exe`);
    renameSync(join(directory, 'muse.exe'), binary);
    writeFileSync(join(directory, '.muse-version'), `${install.version}\n`);
    return binary;
  } finally {dropPart(part);}
}

async function main() {
  // Each preparation owns a new prefix. Never reuse a runner's global CLI or credentials.
  const root = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'boite-synthetic-native-providers-'));
  if (process.argv[2]) mkdirSync(root, {recursive: false});
  writeFileSync(join(root, 'package.json'), '{"private":true}');
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
    wanted['BOITE_TEST_MUSE_CLI'] = await prepareWindowsMuse(root);
    if (process.env['GITHUB_ENV']) appendFileSync(process.env['GITHUB_ENV'], `npm_config_prefix=${root}\n`);
    for (const name of ['CLAUDE', 'CODEX', 'OPENCODE', 'PI', 'MUSE']) {
      const key = `BOITE_TEST_${name}_CLI`, value = wanted[key];
      if (!value) throw new Error(`native fixture: no installed ${name} executable`);
      if (process.env['GITHUB_ENV']) appendFileSync(process.env['GITHUB_ENV'], `${key}=${value}\n`);
      console.log(`${key}=${value}`);
    }
  } finally {await procs.killAll(); await procs.close(); journal.close();}
}
if (import.meta.main) await main();
