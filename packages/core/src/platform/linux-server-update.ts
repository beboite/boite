import { accessSync, chmodSync, constants, copyFileSync, existsSync, linkSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FileLock } from '../server-update/restore.ts';
import { posixLockFile } from './posix-file-lock.ts';
import { recoveryLink, type ServerUpdatePlatform, type UpdateCommand } from '../server-update/types.ts';

/** One quoted word of a unit command line. systemd would expand `$` and `%` inside it, so those are refused. */
export function unitWord(path: string): string {
  if (/[\p{Cc}$%]/u.test(path)) throw new Error(`Server update path ${JSON.stringify(path)} must not contain $, % or control characters`);
  return `"${path.replace(/[\\"]/g, char => `\\${char}`)}"`;
}

const flock = posixLockFile('linux');

/** The maintenance lock: `flock(2)`, never stale and never read half-written (`posix-file-lock.ts`). */
export const linuxFileLock: FileLock = (file) => {
  const held = flock(file);
  if (!held) throw new Error(`a server update holds ${file} while it restores the data beside it; start the server again once it is done`);
  return () => held.release();
};

/** Only the user service whose main process is this standalone core may replace its installation. */
export function linuxServerUpdates(): ServerUpdatePlatform {
  const command = async (args: string[]): Promise<string> => {
    const child = Bun.spawn({ cmd: ['systemctl', '--user', ...args], stdout: 'pipe', stderr: 'pipe' });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`systemctl ${args[0]}: ${error.trim() || `exit ${code}`}`);
    return out.trim();
  };
  return {
    async inspect(run: UpdateCommand) {
      if (!process.env.INVOCATION_ID || process.env.BOITE_UI_DIR || process.env.BOITE_CLI_DIR) return null;
      if (basename(process.execPath) !== 'boite-core') return null;
      const service = process.env.BOITE_SERVER_SERVICE ?? 'boite.service';
      if (!/^[A-Za-z0-9_.@-]+\.service$/.test(service)) throw new Error('BOITE_SERVER_SERVICE must name a systemd user .service');
      const executable = realpathSync(process.execPath);
      const directory = dirname(executable);
      // The updater switches one complete directory; a symlinked install needs its own manager.
      if (lstatSync(process.execPath).isSymbolicLink() || realpathSync(directory) !== directory) return null;
      if (!existsSync(join(directory, 'boite')) || !existsSync(join(directory, 'ui', 'index.html'))) return null;
      accessSync(directory, constants.W_OK);
      accessSync(dirname(directory), constants.W_OK);
      const pid = await run('systemctl', ['--user', 'show', service, '--property=MainPID', '--value']);
      if (Number(pid.trim()) !== process.pid) return null;
      const start = await run('systemctl', ['--user', 'show', service, '--property=ExecStart', '--value']);
      if (!start.includes(`path=${executable} ;`)) return null;
      const restart = await run('systemctl', ['--user', 'show', service, '--property=Restart', '--value']);
      if (!['no', 'on-failure'].includes(restart.trim())) return null;
      return { directory, executable, service };
    },
    async launch(run, executable, plan) {
      // A new systemd cgroup survives the core unit's default KillMode=control-group.
      const operation = basename(dirname(plan));
      if (!/^\.boite-update-[a-f0-9-]{36}$/.test(operation)) throw new Error('Server update plan must be in its private operation directory');
      // The recovery runs the very binary that ran the worker, whatever the switch did to the installation.
      const recovery = recoveryLink(plan);
      rmSync(recovery, { force: true });
      try { linkSync(executable, recovery); } catch { copyFileSync(executable, recovery); chmodSync(recovery, 0o700); }
      try {
        await run('systemd-run', ['--user', `--unit=${operation.slice(1)}`, '--collect', '--quiet', '--property=Nice=10',
          // Throttled, not capped: the snapshot's page cache once filled a 512M MemoryMax and the kernel killed the worker mid-copy.
          '--property=MemoryHigh=1G', '--property=CPUQuota=100%',
          // The recovery may stop the old core, restore a snapshot and wait for health.
          '--property=TimeoutStopSec=15min',
          // Runs however the worker ends, a kill included: it completes or undoes the switch and starts the service again.
          `--property=ExecStopPost=-${unitWord(recovery)} update-recover ${unitWord(plan)}`,
          executable, 'update-apply', plan]);
      } catch (error) { rmSync(recovery, { force: true }); throw error; }
    },
    control: async (service, action) => { await command([action, service]); },
    mainPid: async (service) => Number(await command(['show', service, '--property=MainPID', '--value'])),
    lock: linuxFileLock,
  };
}
