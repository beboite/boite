/** Bounded sampling probe. --live --roots N adds sleeping fixtures, never providers. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LinuxLoad } from '../packages/core/src/platform/linux-load.ts';

if (Bun.argv.includes('--process-load-fixture')) {
  process.stdout.write('ready\n');
  setInterval(() => {}, 60_000);
} else {
  await main();
}

async function ready(child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const output = async (): Promise<void> => {
    let text = '';
    try {
      while (!text.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`fixture pid ${child.pid} closed stdout before readiness`);
        text += new TextDecoder().decode(chunk.value);
        if (text.length > 128) throw new Error(`fixture pid ${child.pid} sent an invalid readiness line`);
      }
      assert.equal(text.trim(), 'ready', `fixture pid ${child.pid} readiness`);
    } finally { reader.releaseLock(); }
  };
  try {
    await Promise.race([
      output(),
      child.exited.then(code => { throw new Error(`fixture pid ${child.pid} exited ${code} before readiness`); }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fixture pid ${child.pid} startup exceeded 10000 ms`)), 10_000);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function main(): Promise<void> {
  const live = Bun.argv.includes('--live');
  if (live && process.platform !== 'linux') throw new Error('--live requires Linux procfs');
  const rootOption = Bun.argv.indexOf('--roots');
  const rootCount = rootOption < 0 ? 0 : Number(Bun.argv[rootOption + 1]);
  assert(rootOption < 0 || live, '--roots requires --live');
  assert(rootOption < 0 || (Number.isSafeInteger(rootCount) && rootCount >= 1 && rootCount <= 64), '--roots must be 1..64');
  const threadCount = live ? rootCount || 1 : 64;
  const systemCount = 256;
  const repeats = 100;
  let reads = 0;
  let statReads = 0;
  let taskReads = 0;
  let at = 1000;
  const read = (path: string): string | null => {
    reads++;
    if (path.endsWith('/stat')) statReads++;
    if (path.endsWith('/children')) taskReads++;
    if (live) {
      try {
        return path === '/proc' || path.endsWith('/task') ? readdirSync(path).join('\n') : readFileSync(path, 'utf8');
      } catch { return null; }
    }
    if (path === '/proc') return Array.from({ length: systemCount }, (_, i) => i + 1).join('\n');
    if (path.endsWith('/stat')) {
      const pid = Number(path.split('/')[2]);
      return `${pid} (agent) S 9999 ${pid} ${pid} 0 -1 4194560 100 0 0 0 7 3 0 0 20 0 8 0 12345 99999`;
    }
    if (path.endsWith('/status')) return 'VmRSS: 1024 kB';
    if (path.endsWith('/comm')) return 'agent';
    if (path.endsWith('/task')) return '1 2 3 4 5 6 7 8';
    if (path.endsWith('/children')) return '';
    return null;
  };
  const load = new LinuxLoad(8, read, () => at);
  const children: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = [];
  const stderr: Promise<string>[] = [];
  try {
    // Embedded Bun paths are virtual; a compiled executable relaunches itself.
    const source = import.meta.path.endsWith('.ts') && !import.meta.path.includes('$bunfs') ? [import.meta.path] : [];
    for (let i = 0; i < rootCount; i++) {
      const child = Bun.spawn({
        cmd: [process.execPath, ...source, '--process-load-fixture'],
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
      });
      children.push(child);
      stderr.push(new Response(child.stderr).text());
    }
    await Promise.all(children.map(ready));
    for (let i = 1; i <= threadCount; i++) load.add(`thread-${i}`, live ? children[i - 1]?.pid ?? process.pid : i);
    Bun.gc(true);
    const rssBeforeBytes = process.memoryUsage().rss;
    let sampledPeakRssBytes = rssBeforeBytes;
    let sampledPeakRootRssBytes = 0;
    let processesVerified = 0;
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    for (let repeat = 0; repeat < repeats; repeat++) {
      at += 1000;
      let rootRssBytes = 0;
      for (let i = 1; i <= threadCount; i++) {
        const pid = live ? children[i - 1]?.pid ?? process.pid : i;
        const sample = load.sample(`thread-${i}`);
        assert(sample !== null && sample.workingSets?.some(row => row.pid === pid), `root ${pid} missing from sampling tick ${repeat}`);
        assert(sample.processes === 1, `root ${pid} should have no fixture descendants`);
        processesVerified++;
        rootRssBytes += sample.memoryBytes;
      }
      sampledPeakRootRssBytes = Math.max(sampledPeakRootRssBytes, rootRssBytes);
      sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    }
    const cpu = process.cpuUsage(cpuStart);
    console.log(JSON.stringify({
      probe: 'process-load', mode: live ? rootCount > 0 ? 'linux-procfs-fixtures' : 'linux-procfs-self' : 'synthetic-procfs',
      threadCount, repeats, reads, statReads, taskReads,
      elapsedMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000,
      rssBeforeBytes, sampledPeakRssBytes, sampledPeakRootRssBytes, processesVerified,
      fixtureRoots: children.length, platform: process.platform, bun: Bun.version,
    }));
  } finally {
    // These handles are captured at spawn. No process outside this fixture is killed.
    const failures: unknown[] = [];
    for (const child of children) {
      try { if (child.exitCode === null) child.kill('SIGKILL'); }
      catch (error) { failures.push(error); }
    }
    const exits = await Promise.allSettled(children.map(child => child.exited));
    for (const exit of exits) if (exit.status === 'rejected') failures.push(exit.reason);
    for (const errors of await Promise.all(stderr)) if (errors) process.stderr.write(errors);
    if (failures.length > 0) throw new AggregateError(failures, 'process-load fixture cleanup failed');
  }
}
