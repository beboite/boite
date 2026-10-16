import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { recommendedPlugins } from '../src/plugins.ts';
import { startTestCore, waitFor } from './harness.ts';

const live = process.env.BOITE_E2E_PLUGIN_INSTALL === '1' ? test : test.skip;
live('the published Bots binary installs with its pinned digest, records its version and uninstalls', async () => {
  const pinned = recommendedPlugins().find((manifest) => manifest.id === 'bots')!;
  const harness = await startTestCore();
  // Bots is a desktop app: a finished install would start it and open its window.
  harness.core.plugins.apps.desktop = () => 'the live install test opens no window';
  try {
    harness.core.plugins.install('bots');
    await waitFor(() => harness.core.plugins.state('bots').status !== 'installing', 120_000);
    expect(harness.core.plugins.state('bots').error).toBeNull();
    expect(harness.core.plugins.state('bots').version).toBe(pinned.version);
    const binary = join(harness.dataDir, 'plugins', 'bots', process.platform === 'win32' ? 'bots.exe' : 'bots');
    // A desktop app may need libraries a headless runner lacks, so the binary is not run here.
    expect(existsSync(binary)).toBe(true);
    await harness.core.plugins.uninstall('bots'); expect(existsSync(binary)).toBe(false);
  } finally { await harness.stop(); }
}, 150_000);
