import { readFileSync, writeFileSync } from 'node:fs';
const path = 'packages/core/test/thread-remove.test.ts';
const original = readFileSync(path, 'utf8');
const checks = [
  ['baseline', original],
  ['shared-core', original.replace('afterEach, beforeEach,', 'afterAll, beforeAll,').replace('beforeEach(async', 'beforeAll(async').replace('afterEach(async', 'afterAll(async')],
  ['no-rejects-matcher', original.replace("await expect(client.call('threads.get', { threadId })).rejects.toThrow('unknown thread');", "expect(await client.call('threads.get', { threadId }).then(() => 'unexpected success', e => e.message)).toContain('unknown thread');")
    .replace("await expect(device.call(method, { threadId })).rejects.toThrow();", "expect(await device.call(method, { threadId }).then(() => 'unexpected success', e => e.message)).not.toBe('unexpected success');")
    .replace("await expect(device.call('threads.deleted', {})).rejects.toThrow();", "expect(await device.call('threads.deleted', {}).then(() => 'unexpected success', e => e.message)).not.toBe('unexpected success');")
    .replace("await expect(client.call('threads.remove', { threadId })).rejects.toThrow('persistent agent sessions');", "expect(await client.call('threads.remove', { threadId }).then(() => 'unexpected success', e => e.message)).toContain('persistent agent sessions');")],
  ['close-delay', original.replace('await harness.stop();', 'await harness.stop(); await Bun.sleep(100); Bun.gc(true);')],
];
try {
  for (const [label, source] of checks) {
    writeFileSync(path, source!);
    for (let i=1;i<=3;i++) {
      console.log(`PROBE ${label} ${i}`);
      const child = Bun.spawn([process.execPath, 'test', path], {stdout:'pipe',stderr:'pipe',windowsHide:true});
      const timer = setTimeout(() => child.kill(), 15000);
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      clearTimeout(timer);
      console.log(out+err); console.log(`PROBE RESULT ${label} ${i}: ${code}`);
    }
  }
} finally { writeFileSync(path, original); }
