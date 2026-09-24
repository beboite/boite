import { existsSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Core } from '../packages/core/src/core.ts';

/** Keep browser-only turns out of the workstation's skills and personalization.
 * The existing subscription login is linked, never read into the benchmark.
 * Only child-process configuration changes; the user's configuration is untouched.
 */
export function createLabContext(core: Core, output: string, isolated: boolean) {
  if (!isolated) return { core, metadata: { isolated: false }, close() {} };
  const home = join(output, 'ephemeral-codex-home');
  mkdirSync(home);
  const auth = join(home, 'auth.json');
  const existing = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  if (!existsSync(existing)) throw new Error('Existing subscription auth.json is required for the isolated context probe.');
  symlinkSync(existing, auth, 'file');
  const overrides = ['developer_instructions=""', 'personality="none"', 'skills.max_context_tokens=1'];
  const procs = new Proxy(core.procs, { get(target, property) {
    if (property !== 'spawnChild') {
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return (key: string, executable: string, args: string[], options: any) => target.spawnChild(key, executable,
      [...args, ...overrides.flatMap(value => ['-c', value])],
      { ...options, env: { ...options.env, CODEX_HOME: home, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined } });
  } });
  return {
    core: new Proxy(core, { get(target, property) { return property === 'procs' ? procs : Reflect.get(target, property); } }) as Core,
    metadata: { isolated: true, overrides, authentication: 'Temporary file link to the existing ChatGPT subscription login; no credential values read or copied.' },
    close() { try { unlinkSync(auth); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } },
  };
}
