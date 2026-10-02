import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENV } from '@boite/contracts';
import { runCli } from '../src/cli.ts';
import { echoThread, startTestCore } from './harness.ts';

test('browser screenshots accept explicit destinations, preserve existing files and document default cleanup', async () => {
  const harness = await startTestCore();
  const owner = await harness.connect();
  try {
    const { threadId } = await echoThread(harness, owner);
    await owner.call('threads.subscribe', { threadId });
    await owner.call('browser.host', { threadId, enabled: true, allowAgentControl: true });
    const png = readFileSync(join(import.meta.dir, '../../ui/public/icons/icon-192.png'));
    owner.on('browser.requested', request => {
      void owner.call('browser.complete', { requestId: request.requestId, result: { tabId: 'browser:test', screenshot: { mime: 'image/png', base64: png.toString('base64') } } });
    });
    const cwd = join(harness.dataDir, 'screenshots'); mkdirSync(cwd);
    const run = async (args: string[]) => {
      let out = '', error = '';
      const code = await runCli(['browser', ...args, '--json'], { cwd,
        env: { [AGENT_ENV.threadId]: threadId, [AGENT_ENV.coreUrl]: harness.url, [AGENT_ENV.token]: harness.core.agents.tokenFor(threadId) },
        out: text => out += text, err: text => error += text });
      return { code, out, error };
    };
    const destination = join(harness.dataDir, 'review capture.png');
    const explicit = await run(['screenshot', 'browser:test', '--output', destination]);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.out).path).toBe(destination);
    expect(readFileSync(destination)).toEqual(png);
    expect(readdirSync(cwd)).toEqual([]);
    expect((await run(['screenshot', '--output', destination])).code).not.toBe(0);
    expect(readFileSync(destination)).toEqual(png);
    expect((await run(['screenshot', '--output', 'relative.png'])).code).toBe(0);
    expect(readFileSync(join(cwd, 'relative.png'))).toEqual(png);
    const automatic = await run(['screenshot']);
    expect(automatic.code).toBe(0);
    expect(JSON.parse(automatic.out).path).toMatch(/boite-browser-[a-f0-9-]+\.png$/);
    expect((await run(['help'])).out).toContain('caller owns cleanup');
    expect((await run(['screenshot', '--output'])).code).not.toBe(0);
  } finally { owner.close(); await harness.stop(); }
});
