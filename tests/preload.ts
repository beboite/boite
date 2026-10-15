import { afterAll } from 'bun:test';
import { sweepStaleDirectories } from './e2e/lib/cleanup.ts';

// Tests never send production analytics. Telemetry tests inject their own relay.
process.env.BOITE_TELEMETRY_URL = '';

// Profiles and data directories an interrupted run left behind, an hour old or more.
sweepStaleDirectories();

// A page a file launched and never closed, a `beforeAll` that timed out
// mid-launch for one: its browser and profile go when the run ends.
afterAll(async () => {
  const { closeAllBrowsers } = await import('./e2e/lib/cdp.ts');
  await closeAllBrowsers();
});
