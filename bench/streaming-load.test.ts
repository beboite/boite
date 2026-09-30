import { expect, test } from 'bun:test';

for (const failure of ['construct', 'close']) {
  test(`the public streaming probe restores its data directory after ${failure} failure`, async () => {
    const journalModule = new URL('../packages/core/src/journal.ts', import.meta.url).href;
    const target = new URL('./streaming-load.ts', import.meta.url).href;
    const code = `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { dirname } from 'node:path';
      import { mock } from 'bun:test';
      const { Journal } = await import(${JSON.stringify(journalModule)});
      let scenarioDir;
      if (${JSON.stringify(failure)} === 'construct') process.env.BOITE_DATA_DIR = 'inherited-sentinel';
      else delete process.env.BOITE_DATA_DIR;
      process.env.BOITE_STREAM_BENCH_CHILD = 'read';
      process.env.BOITE_STREAM_BENCH_STREAMS = '1';
      process.env.BOITE_STREAM_BENCH_CYCLES = '1';
      class ProbeJournal extends Journal {
        constructor(file) {
          scenarioDir = dirname(file);
          assert.equal(process.env.BOITE_DATA_DIR, scenarioDir);
          if (${JSON.stringify(failure)} === 'construct') throw new Error('construct failure');
          super(file);
        }
        close() { super.close(); throw new Error('close failure'); }
      }
      mock.module(${JSON.stringify(journalModule)}, () => ({ Journal: ProbeJournal }));
      await assert.rejects(import(${JSON.stringify(target)}), /${failure} failure/);
      assert.equal(process.env.BOITE_DATA_DIR, ${failure === 'construct' ? "'inherited-sentinel'" : 'undefined'});
      assert(scenarioDir);
      assert.equal(existsSync(scenarioDir), false);
      console.log('environment restored and temporary directory removed');
    `;
    const child = Bun.spawn({ cmd: [process.execPath, '-e', code], windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('environment restored and temporary directory removed');
  });
}
