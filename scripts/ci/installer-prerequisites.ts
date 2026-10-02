import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface InstallerOptions {
  root?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Missing native fixtures may skip locally, but must fail in the desktop CI job. */
export function installerPrerequisites({ root = resolve(import.meta.dir, '../..'), platform = process.platform, env = process.env }: InstallerOptions = {}) {
  const nsis = join(env.LOCALAPPDATA ?? '', 'tauri', 'NSIS');
  const makensis = join(nsis, 'makensis.exe');
  const plugins = join(nsis, 'Plugins', 'x86-unicode', 'additional');
  const target = resolve(root, env.CARGO_TARGET_DIR ?? 'apps/shell/src-tauri/target');
  const generated = join(target, 'release', 'nsis', 'x64');
  const missing = [makensis, plugins, ...['installer.nsi', 'utils.nsh', 'FileAssociation.nsh'].map(file => join(generated, file))]
    .filter(path => !existsSync(path));
  const ready = platform === 'win32' && missing.length === 0;
  if (env.BOITE_CI_INSTALLER_REQUIRED === '1' && !ready) {
    throw new Error(`BOITE_CI_INSTALLER_REQUIRED=1: expected Windows installer prerequisites from bun run build:shell.\n`
      + (platform === 'win32' ? '' : `platform: expected win32, received ${platform}\n`)
      + missing.map(path => `${path}: missing`).join('\n'));
  }
  return { nsis, makensis, plugins, generated, ready };
}
