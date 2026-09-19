/**
 * The releases the shipped Codex and OpenCode descriptors pin, downloaded and
 * started once. Opt-in behind `BOITE_E2E_INSTALLS=1`, because it pulls about
 * 170 MB from GitHub.
 *
 *   $env:BOITE_E2E_INSTALLS='1'; bun test test/shipped-installs.live.test.ts
 *
 * What it proves: `providers.install` downloads the descriptor's archive, its
 * sha256 and length match, every listed file lands with the size the descriptor
 * names, the managed file is the executable the provider resolves to, and that
 * executable answers `--version`. It never signs in, and the whole data
 * directory goes at the end, failure or not.
 */
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import type { ProviderInstallState } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { profileFor, resolveExecutable } from '../src/providers/loader.ts';
import { startServer } from '../src/server.ts';
import { removeDir, waitFor } from './harness.ts';

const live = process.env['BOITE_E2E_INSTALLS'] === '1';
const run = live ? test : test.skip;
const TIMEOUT_MS = 10 * 60_000;

/** Everything this run wrote, deleted whatever happens. */
const dataDirs: string[] = [];

afterAll(async () => {
  for (const dir of dataDirs) await removeDir(dir);
});

describe('the releases the shipped descriptors pin', () => {
  for (const providerId of ['opencode', 'codex']) {
    run(
      `${providerId} installs from its release, matches its sha256 and answers --version`,
      async () => {
        const root = join(process.env['TEMP'] ?? '/tmp', 'boite-installs');
        mkdirSync(root, { recursive: true });
        const dataDir = mkdtempSync(join(root, `${providerId}-`));
        dataDirs.push(dataDir);
        process.env['BOITE_DATA_DIR'] = dataDir;

        const token = newToken();
        const core = new Core({ dataDir, token });
        const server = startServer({ core, host: '127.0.0.1', port: 0 });
        const client = await connect(server.url, token);

        try {
          const profile = profileFor(core.providers.require(providerId));
          if (profile?.install === undefined) {
            console.log(`${providerId} ships no release for this platform`);
            return;
          }
          const states: ProviderInstallState['state'][] = [];
          let failure = '';
          client.on('providers.installProgress', (event) => {
            if (event.providerId !== providerId) return;
            if (event.state === 'failed') failure = event.message;
            if (states.at(-1) !== event.state) states.push(event.state);
          });

          const accepted = await client.call('providers.install', { providerId });
          expect(accepted.state).toBe('downloading');
          await waitFor(() => states.includes('installed') || states.includes('failed'), TIMEOUT_MS);
          // A wrong digest or a wrong length is a refusal, so reaching `installed`
          // is both checks passing on the real bytes.
          expect(failure).toBe('');
          expect(states.at(-1)).toBe('installed');

          const current = join(dataDir, 'agents', providerId, 'current');
          for (const file of profile.install.files) {
            expect(existsSync(join(current, file.path))).toBe(true);
            expect(statSync(join(current, file.path)).size).toBe(file.bytes);
          }
          const executable = resolveExecutable(profile);
          expect(executable).toBe(join(current, profile.install.files[0]?.path ?? ''));

          const spawned = core.procs.spawnPiped(`probe:${providerId}:install-check`, executable ?? '', ['--version'], {
            cwd: dataDir,
            env: {},
          });
          const output = await new Response(spawned.proc.stdout).text();
          expect(await spawned.exited).toBe(0);
          console.log(`${providerId} --version: ${output.trim()}`);
          expect(output).toContain(profile.install.version);
        } finally {
          client.close();
          await server.stop();
          await core.close();
          delete process.env['BOITE_DATA_DIR'];
        }
      },
      TIMEOUT_MS,
    );
  }
});
