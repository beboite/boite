import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findChromium } from '../src/browser/chromium.ts';
import { connect } from '../src/client.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

const example = join(import.meta.dir, '../../../examples/view-kit');
const browserTest = findChromium().path ? test : test.skip;

for (const scheme of ['dark', 'light'] as const) {
  browserTest(`the opt-in view kit composes state, SVG, comparisons, choices, steps and media in ${scheme}`, async () => {
    const harness = await startTestCore();
    const owner = await harness.connect();
    let agent: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      // The fixture and every embedded asset belong to a new, isolated project.
      cpSync(example, join(harness.dataDir, 'kit'), { recursive: true });
      const { threadId } = await echoThread(harness, owner, 'View kit example');
      await owner.call('turns.start', { threadId, prompt: 'fixture' });
      await waitFor(() => harness.core.threads.require(threadId).status === 'idle');
      agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
      const result = await agent.call('artifacts.viewCheck', {
        threadId, path: 'kit/example.html', scheme,
        script: readFileSync(join(example, 'checks.js'), 'utf8'),
      });
      expect(result.checked).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.advice).toEqual([]);
      expect(result.captures.map(capture => capture.width)).toEqual([816, 330]);
      for (const capture of result.captures) {
        expect(capture.value).toMatchObject({ checks: 29, sharedState: true, svg: true, wipe: true, media: true, disposed: true });
        const shots = process.env.BOITE_VIEW_KIT_CAPTURE_DIR;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          writeFileSync(join(shots, `view-kit-${scheme}-${capture.width}.png`), Buffer.from(capture.png, 'base64'));
        }
      }
    } finally {
      agent?.close(); owner.close(); await harness.stop();
    }
  }, 90_000);
}
