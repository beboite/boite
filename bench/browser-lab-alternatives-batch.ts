import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startTestCore } from '../packages/core/test/harness.ts';
import { labTasks } from './browser-lab-tasks.ts';

if (process.env.BOITE_BENCH_ALTERNATIVES !== '1') throw new Error('Set BOITE_BENCH_ALTERNATIVES=1 for live subscription probes.');
const output = resolve(process.env.BOITE_BENCH_OUTPUT!);
mkdirSync(output, { recursive: true });
const core = await startTestCore();
const results: unknown[] = [];
try {
  for (const task of labTasks.filter(task => task.id !== 'github-issue-investigation')) {
    const directory = join(output, task.id); mkdirSync(directory, { recursive: true });
    const group = `alternative-batch:${task.id}`;
    const env: Record<string, string | undefined> = { ...process.env, BOITE_BENCH_ALTERNATIVE: 'browser-use', BOITE_BENCH_TASKS: task.id, BOITE_BENCH_OUTPUT: directory, BOITE_BENCH_TIMEOUT_MS: '180000' };
    if (!['google-maps-walking', 'google-flights-roundtrip'].includes(task.id)) delete env.BOITE_BENCH_FFMPEG;
    const started = Date.now();
    const child = core.core.procs.spawnChild(group, process.execPath, [join(import.meta.dir, 'browser-lab-alternatives.ts')], { cwd: process.cwd(), env });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const timer = setTimeout(() => core.core.procs.killTree(group), 240_000);
    let exitCode: unknown;
    try { exitCode = await new Promise(resolve => child.once('close', resolve)); }
    finally { clearTimeout(timer); await core.core.procs.stopAndWait(group); }
    writeFileSync(join(directory, 'runner.stdout.log'), stdout); writeFileSync(join(directory, 'runner.stderr.log'), stderr);
    const result = { task: task.id, exitCode, elapsedMs: Date.now() - started, processesAfter: core.core.procs.liveCount(group) };
    results.push(result); writeFileSync(join(output, 'batch.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(result));
  }
} finally { await core.stop(); }
