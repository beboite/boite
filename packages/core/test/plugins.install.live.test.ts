import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { startTestCore, waitFor } from './harness.ts';

const live = process.env.BOITE_E2E_KEBACC_INSTALL === '1' ? test : test.skip;
live('the published kebacc binary installs with its pinned digest, reports its version and uninstalls', async () => {
  const harness = await startTestCore();
  try {
    harness.core.plugins.install('kebacc-switcher');
    await waitFor(() => harness.core.plugins.state().status !== 'installing', 120_000);
    expect(harness.core.plugins.state().error).toBeNull();
    expect(harness.core.plugins.state().version).toBe('2.0.1');
    const binary = join(harness.dataDir, 'plugins', 'kebacc-switcher', process.platform === 'win32' ? 'kebacc.exe' : 'kebacc');
    const spawned = harness.core.procs.spawn('plugin:version-test', binary, ['--version']);
    const text = await new Response(spawned.proc.stdout).text();
    expect(await spawned.exited).toBe(0); expect(text).toContain('2.0.1');
    await harness.core.plugins.uninstall('kebacc-switcher'); expect(existsSync(binary)).toBe(false);
  } finally { await harness.stop(); }
}, 150_000);
