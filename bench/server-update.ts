/**
 * What a server update costs the running core: download, signature check and
 * unpack of a real server archive, with the longest event loop stall.
 *
 *   bun bench/server-update.ts prepare <boite-core> <ui dir> <out dir>
 *   bun bench/server-update.ts run <release.ts> <archive url> <signature file> <work dir>
 *
 * `prepare` writes `payload.zip`, built the way releases are, and a Minisign
 * packet with the publisher's key id but no valid signature: both versions do
 * all their reading and hashing, then refuse it at the very end. `run` takes the
 * module to measure, so the same script measures `origin/main` and a branch.
 * Peak RSS comes from the caller: `/usr/bin/time -f %M`.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [mode, ...args] = process.argv.slice(2);

if (mode === 'prepare') {
  const [core, ui, out] = args as [string, string, string];
  const { serverBundle } = await import('../packages/core/bin/server-bundle.ts');
  const { UPDATE_PUBLIC_KEY } = await import('../packages/core/src/server-update/release.ts');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'payload.zip'), serverBundle(core, ui, '9.9.9'));
  const keyId = Buffer.from(Buffer.from(UPDATE_PUBLIC_KEY, 'base64').toString('utf8').trim().split('\n')[1]!, 'base64').subarray(2, 10);
  const packet = Buffer.concat([Buffer.from('ED'), keyId, randomBytes(64)]).toString('base64');
  writeFileSync(join(out, 'signature'), Buffer.from(`untrusted comment: bench\n${packet}\ntrusted comment: bench\n${randomBytes(64).toString('base64')}\n`).toString('base64'));
} else if (mode === 'run') {
  const [module, url, signatureFile, work] = args as [string, string, string, string];
  const release = await import(resolve(module)) as typeof import('../packages/core/src/server-update/release.ts');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  let stall = 0;
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); stall = Math.max(stall, now - last - 5); last = now; }, 5);
  /** The longest stall of a phase, read once timers had a turn after it: a block at its very end counts. */
  const phase = async (work: () => Promise<unknown>) => {
    await Bun.sleep(20);
    stall = 0;
    const started = performance.now();
    await work();
    const ms = performance.now() - started;
    await Bun.sleep(20);
    return { ms: Math.round(ms), stallMs: Math.round(stall) };
  };
  const offer = { version: '9.9.9', publishedAt: '', url, signature: readFileSync(signatureFile, 'utf8') };
  let refused = '';
  const download = await phase(() => release.downloadPayload(offer, join(work, 'payload.zip'), AbortSignal.timeout(120_000), () => {}).catch((error: unknown) => { refused = String(error); }));
  const unpack = await phase(async () => release.unpackPayload(join(work, 'payload.zip'), join(work, 'stage'), '9.9.9'));
  clearInterval(timer);
  rmSync(work, { recursive: true, force: true });
  if (!refused.includes('verification failed')) throw new Error(`expected the bench signature to be refused, got: ${refused || 'accepted'}`);
  console.log(JSON.stringify({ download, unpack }));
} else {
  throw new Error('usage: server-update.ts prepare <boite-core> <ui dir> <out dir> | run <release.ts> <archive url> <signature file> <work dir>');
}
