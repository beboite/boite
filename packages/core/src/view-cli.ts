import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type { ViewCheckCapture } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import { Usage } from './cli-args.ts';

const CHECK_USAGE = 'view check expects <file.html> [--script checks.js] [--scheme dark|light]';

/** Check without publishing: only the CLI writes the returned screenshots to its own cwd. */
export async function viewCheckCommand(args: string[], cwd: string, client: CoreClient, threadId: string) {
  let path: string | undefined, scriptPath: string | undefined, scheme: 'dark' | 'light' | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--script' || arg === '--scheme') {
      const value = args[++index];
      if (value === undefined || !value || value.startsWith('--')) throw new Usage(`${arg} needs a value; ${CHECK_USAGE}`);
      if (arg === '--script') {
        if (scriptPath !== undefined) throw new Usage('--script may only be given once');
        scriptPath = value;
      } else {
        if (scheme !== undefined) throw new Usage('--scheme may only be given once');
        if (value !== 'dark' && value !== 'light') throw new Usage('--scheme expects dark or light');
        scheme = value;
      }
    } else {
      if (arg.startsWith('--') || path !== undefined) throw new Usage(CHECK_USAGE);
      path = arg;
    }
  }
  if (!path) throw new Usage(CHECK_USAGE);
  const result = await client.call('artifacts.viewCheck', {
    threadId, path: resolve(cwd, path),
    ...(scriptPath === undefined ? {} : { script: readFileSync(resolve(cwd, scriptPath), 'utf8') }),
    ...(scheme === undefined ? {} : { scheme }),
  });
  const errors = [...result.errors];
  const captures: Array<Omit<ViewCheckCapture, 'png'> & { path: string }> = [];
  const stem = basename(path, extname(path)).replace(/[^a-z0-9._-]/gi, '-').slice(0, 64) || 'view';
  for (const { png, ...capture } of result.captures) {
    try {
      const saved = resolve(cwd, `${stem}-check-${randomUUID()}-${capture.width}.png`);
      // Exclusive creation also protects an existing file if a name ever collides.
      writeFileSync(saved, Buffer.from(png, 'base64'), { flag: 'wx' });
      captures.push({ ...capture, path: saved });
    } catch (error) {
      errors.push(`could not save the ${capture.width}px capture: ${(error as Error).message}`);
    }
  }
  const value = { checked: result.checked, errors, advice: result.advice, captures };
  return {
    value,
    lines: [
      `checked: ${result.checked ? 'yes' : 'no'}`,
      ...captures.flatMap(capture => [
        `capture: ${capture.path} (${capture.width}x${capture.height})`,
        ...(capture.value === undefined ? [] : [`result: ${capture.width}px ${JSON.stringify(capture.value)}`]),
      ]),
      ...errors.map(error => `error: ${error}`),
      ...result.advice.map(advice => `advice: ${advice}`),
    ],
    code: result.checked && errors.length === 0 ? 0 : 1,
  };
}
