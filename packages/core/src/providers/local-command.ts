/**
 * Settings > Providers > Local ACP command: an ACP agent the owner describes by
 * the command that starts it, written as an ordinary user descriptor under
 * `<dataDir>/providers/`, so the loader, the ACP driver and `providers.dryRun`
 * treat it like a file written by hand.
 */
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkLocalAcpCommand,
  threadActive,
  type LocalAcpCommand,
  type Os,
  type ProviderId,
  type ProviderRejected,
  type ProviderSummary,
} from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, notFound, refused } from '../errors.ts';
import { currentOs } from '../paths.ts';
import { launcherScriptOnly, profileFor, resolveCommand } from './resolve.ts';
import { Rejection, validateDescriptor } from './validate.ts';

type ProviderList = { loaded: ProviderSummary[]; rejected: ProviderRejected[] };

/**
 * The descriptor a command becomes. No `login` and no isolation: the agent
 * signs in and keeps its settings in its own files, so its default account
 * reads the owner's own configuration. The single `default` model leaves the
 * agent on the model it is configured with until `providers.probe` reads its list.
 */
export function localAcpDescriptor(id: ProviderId, command: LocalAcpCommand, executable: { kind: 'file' | 'path'; value: string }, os: Os): Record<string, unknown> {
  return {
    id,
    schemaVersion: 1,
    name: command.name,
    shortName: command.name,
    protocol: 'acp',
    roots: ['{isolationDir}'],
    profiles: {
      [os]: {
        detect: {},
        executable: [executable],
        launch: { args: command.args },
        isolation: {},
        ...(Object.keys(command.env).length === 0 ? {} : { env: command.env }),
      },
    },
    auth: { kind: 'none' },
    models: [{ id: 'default', name: 'Agent default', default: true }],
    // ACP's own answers decide the rest: `initialize` says whether images and
    // `session/load` are supported, and the driver checks before using either.
    capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: false, resume: true },
  };
}

function refusal(message: string, field: string, expected: string, extra: Record<string, unknown> = {}): never {
  throw invalidParams(message, { field, expected, ...extra });
}

/** `reload` reads the descriptors again and tells every client, as `providers.reload` does. */
export function registerLocalCommands(core: Core, reload: () => Promise<ProviderList>): void {
  const dir = join(core.dataDir, 'providers');

  core.router.register('providers.addLocal', async (params) => {
    const os = currentOs();
    const checked = checkLocalAcpCommand(params, os);
    if (!checked.ok) refusal(checked.refusal.message, checked.refusal.field, checked.refusal.expected);
    const { id, command, executable } = checked;
    const file = join(dir, `${id}.json`);
    if (core.providers.get(id) !== undefined || existsSync(file)) {
      refusal(`a provider with the id ${id} already exists`, 'name', 'a name no other provider uses', { providerId: id });
    }

    const raw = localAcpDescriptor(id, command, executable, os);
    const shipped = new Set(core.providers.list().loaded.filter((entry) => entry.source === 'shipped').map((entry) => entry.id));
    let profile;
    try {
      profile = profileFor(validateDescriptor(structuredClone(raw), file, shipped, core.dataDir), os);
    } catch (error) {
      if (error instanceof Rejection) refusal(error.rejected.message, error.rejected.field, error.rejected.expected);
      throw error;
    }
    if (profile === undefined || resolveCommand(profile) === null) {
      const launcher = profile === undefined ? null : launcherScriptOnly(profile);
      refusal(
        launcher === null
          ? `Boite cannot find ${command.command} on this machine`
          : `${command.command} on PATH is the launcher script ${launcher}: enter the program it starts`,
        'command',
        'a program this machine can start',
      );
    }

    mkdirSync(dir, { recursive: true });
    const partial = `${file}.${process.pid}.part`;
    // Owner-only: the file holds the environment values in plain text.
    writeFileSync(partial, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(partial, file);
    const list = await reload();
    if (!list.loaded.some((entry) => entry.id === id)) {
      // Only a file that loads stays: a refusal here would otherwise sit on the page as a rejected descriptor.
      const why = list.rejected.find((entry) => entry.file === file);
      unlinkSync(file);
      await reload();
      throw invalidParams(why?.message ?? `${id} did not load`, { field: why?.field ?? 'command', expected: why?.expected ?? 'a descriptor that loads' });
    }
    return { providerId: id, ...list };
  });

  core.router.register('providers.removeLocal', async (params) => {
    const id = params.providerId;
    const summary = typeof id === 'string' ? core.providers.summary(id) : undefined;
    if (summary === undefined) throw notFound(`unknown provider ${String(id)}`, { providerId: id });
    if (summary.source !== 'user') {
      throw refused(`${summary.name} ships with Boite and cannot be removed; turn it off instead`, { providerId: id, field: 'providerId', expected: 'a provider added on this machine' });
    }
    const threads = core.journal.listThreads().filter((thread) => thread.providerId === id);
    if (threads.some((thread) => threadActive(thread.status))) {
      throw refused(`a turn of ${summary.name} is still running: stop it first`, { providerId: id });
    }
    for (const thread of threads) core.threads.releaseAgent(thread.id);
    const file = core.providers.userFile(id);
    if (file !== undefined && existsSync(file)) unlinkSync(file);
    return reload();
  });
}
