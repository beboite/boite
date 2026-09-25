/**
 * The real Antigravity release, downloaded and started once. Opt-in behind
 * `BOITE_E2E_ANTIGRAVITY_INSTALL=1`, because it pulls 468 MB from Google and
 * takes about a minute.
 *
 *   $env:BOITE_E2E_ANTIGRAVITY_INSTALL='1'; bun test test/antigravity.install.live.test.ts
 *
 * What it proves: `providers.install` downloads the descriptor's archive, its
 * sha256 matches, every listed file lands with the size the descriptor names,
 * and the server that comes out answers `initialize` with the `oauth-personal`
 * sign-in Boite's login asks for. It never signs in: no Google page is opened
 * and no browser is launched, and the whole data directory goes at the end,
 * failure or not.
 */
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, describe, expect, test } from 'bun:test';
import type { ProviderInstallState } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { jsonLinesOnly } from '../src/drivers/acp/stdout.ts';
import { newToken } from '../src/ids.ts';
import { agentEnv, profileFor, resolveExecutable } from '../src/providers/loader.ts';
import { startServer } from '../src/server.ts';
import { removeDir, waitFor } from './harness.ts';

const live = process.env['BOITE_E2E_ANTIGRAVITY_INSTALL'] === '1';
const run = live ? test : test.skip;
/** The download plus the unpack of a gigabyte of files, on a slow morning. */
const TIMEOUT_MS = 15 * 60_000;

/** Everything this run wrote, deleted whatever happens. */
const dataDirs: string[] = [];

afterAll(async () => {
  for (const dir of dataDirs) await removeDir(dir);
});

describe('the real antigravity release', () => {
  run(
    'installs from google, matches its sha256, and answers initialize with the oauth-personal method',
    async () => {
      const root = join(process.env['TEMP'] ?? '/tmp', 'agy-install');
      mkdirSync(root, { recursive: true });
      const dataDir = mkdtempSync(join(root, 'run-'));
      dataDirs.push(dataDir);
      process.env['BOITE_DATA_DIR'] = dataDir;

      const token = newToken();
      const core = new Core({ dataDir, token });
      const server = startServer({ core, host: '127.0.0.1', port: 0 });
      const client = await connect(server.url, token);

      try {
        const states: ProviderInstallState['state'][] = [];
        client.on('providers.installProgress', (event) => {
          if (event.providerId !== 'antigravity') return;
          if (states.at(-1) !== event.state) {
            states.push(event.state);
            console.log(`install ${event.state}`);
          }
        });

        const before = await client.call('providers.list', {});
        const summary = before.loaded.find((provider) => provider.id === 'antigravity');
        expect(summary?.install?.state).toBe('absent');
        expect(summary?.available).toBe(false);

        // The call answers as soon as the download starts; the rest of the run
        // arrives as `providers.installProgress`.
        const accepted = await client.call('providers.install', { providerId: 'antigravity' });
        expect(accepted.state).toBe('downloading');
        await waitFor(() => states.includes('installed') || states.includes('failed'), TIMEOUT_MS);

        const after = await client.call('providers.list', {});
        const installed = after.loaded.find((provider) => provider.id === 'antigravity')?.install;
        // A wrong digest or a wrong length is a refusal, so reaching `installed`
        // is the sha256 check passing on Google's real bytes.
        expect(installed?.state).toBe('installed');
        expect(states).toContain('downloading');
        expect(states).toContain('verifying');
        expect(states).toContain('extracting');
        console.log(`installed ${installed?.version ?? ''}`);

        const descriptor = core.providers.require('antigravity');
        const profile = profileFor(descriptor);
        const executable = profile === undefined ? null : resolveExecutable(profile);
        expect(executable).not.toBeNull();
        for (const file of profile?.install?.files ?? []) {
          const path = join(dataDir, 'agents', 'antigravity', 'current', file.path);
          expect(existsSync(path)).toBe(true);
          expect(statSync(path).size).toBe(file.bytes);
          console.log(`file ${file.path} ${statSync(path).size}`);
        }

        // One process, `initialize` only. No `authenticate` goes out, so no
        // Google sign-in is ever started.
        const account = await client.call('accounts.add', {
          providerId: 'antigravity',
          label: 'install check',
          useDefaultLocation: true,
        });
        const entry = core.accounts.require(account.id);
        const env = agentEnv(descriptor, core.accounts.accountEnv(entry, descriptor));
        const child = core.procs.spawnChild('login:install-check', executable ?? '', profile?.launch?.args ?? [], {
          cwd: dataDir,
          env,
        });
        try {
          const sdk = await import('@agentclientprotocol/sdk');
          const stream = sdk.ndJsonStream(
            Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
            jsonLinesOnly(Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>, (line) => {
              console.log(`agent: ${line.slice(0, 200)}`);
            }),
          );
          const connection = sdk.client({ name: 'boite' }).connect(stream);
          const init = await connection.agent.request('initialize', {
            protocolVersion: sdk.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: 'boite', version: '0' },
          });
          console.log(`initialize protocolVersion=${String(init.protocolVersion)}`);
          console.log(`authMethods ${(init.authMethods ?? []).map((method) => method.id).join(', ')}`);
          expect((init.authMethods ?? []).map((method) => method.id)).toContain('oauth-personal');
          connection.close();
        } finally {
          child.kill();
        }
      } finally {
        client.close();
        await server.stop();
        await core.close();
        delete process.env['BOITE_DATA_DIR'];
      }
    },
    TIMEOUT_MS,
  );
});
