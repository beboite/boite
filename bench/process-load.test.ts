import { expect, test } from 'bun:test';

test('the public process probe retains readiness and cleanup errors', async () => {
  const target = new URL('./process-load.ts', import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Bun.argv.push('--live', '--roots', '1');
    let kills = 0;
    let finish;
    const exited = new Promise(resolve => { finish = resolve; });
    Bun.spawn = () => ({
      pid: 777, exitCode: null, exited,
      stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('invalid\\n')); controller.close(); } }),
      stderr: new ReadableStream({ start(controller) { controller.error(new Error('stderr reader failure')); } }),
      kill() { kills++; finish(0); throw new Error('fixture kill failure'); },
    });
    try { await import(${JSON.stringify(target)}); assert.fail('probe must fail'); }
    catch (error) {
      assert(error instanceof AggregateError);
      assert.match(error.errors[0].message, /readiness/);
      assert.equal(error.cause, error.errors[0]);
      assert(error.errors.some(item => item.message === 'fixture kill failure'));
      assert(error.errors.some(item => item.message === 'stderr reader failure'));
      assert.equal(kills, 1);
    }
    console.log('primary, cleanup and stderr failures retained');
  `;
  const child = Bun.spawn({ cmd: [process.execPath, '-e', code], windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  expect(stdout).toContain('primary, cleanup and stderr failures retained');
});
