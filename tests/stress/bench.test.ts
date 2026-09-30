import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree, removeDirectory } from '../e2e/lib/cleanup.ts';

test('a health failure marks the mass cancellation report failed despite successful agent stops', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-stress-report-'));
  const output = join(directory, 'report.json');
  const proc = Bun.spawn({
    windowsHide: true,
    cmd: [process.execPath, 'run', join(import.meta.dir, '../../bench/agent-stress.ts'),
      '--core', join(import.meta.dir, 'lib/unhealthy-core.ts'), '--threads', '40', '--concurrency', '6', '--clients', '2', '--output', output],
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => killProcessTree(proc.pid), 30_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (process.env.BOITE_STRESS_ARTIFACTS) {
      mkdirSync(process.env.BOITE_STRESS_ARTIFACTS, { recursive: true });
      writeFileSync(join(process.env.BOITE_STRESS_ARTIFACTS, 'health-failure.log'), stdout + stderr);
      writeFileSync(join(process.env.BOITE_STRESS_ARTIFACTS, 'health-failure-report.json'), readFileSync(output));
    }
    expect(exitCode).toBe(1);
    const report = JSON.parse(readFileSync(output, 'utf8')) as {
      status: string; scenarios: { scenario: string; status: string; accepted: number; stopped: number; healthErrors: string[] }[];
    };
    const cancellation = report.scenarios.find(scenario => scenario.scenario === 'mass cancellation');
    if (!cancellation) throw new Error(`mass cancellation did not run:\n${stdout}${stderr}\n${JSON.stringify(report)}`);
    expect(cancellation?.accepted).toBe(40);
    expect(cancellation?.stopped).toBe(40);
    expect(cancellation?.healthErrors.length).toBeGreaterThan(0);
    expect(report.status).toBe('failed');
    expect(cancellation?.status).toBe('failed');
  } finally {
    clearTimeout(timer);
    killProcessTree(proc.pid);
    await proc.exited;
    await removeDirectory(directory);
  }
}, 40_000);
