/** Opt-in subscription context probe. Does not modify the frozen browser campaign. */
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Core } from '../packages/core/src/core.ts';
import { startTestCore } from '../packages/core/test/harness.ts';
import { BrowserLabCodex } from './browser-lab-codex.ts';

const prompt = 'What is 17 plus 25? Give the answer in one short sentence.';
const taskOnlyOverrides = ['developer_instructions=""', 'personality="none"', 'skills.max_context_tokens=1'];
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function main() {
  if (process.env.BOITE_BENCH_CONTEXT_PROBE !== '1') throw new Error('Set BOITE_BENCH_CONTEXT_PROBE=1 to enable subscription-backed probe turns.');
  const output = process.env.BOITE_BENCH_CONTEXT_OUTPUT;
  const binary = process.env.BOITE_BENCH_CODEX_BINARY;
  if (!output || !binary) throw new Error('Expected BOITE_BENCH_CONTEXT_OUTPUT and BOITE_BENCH_CODEX_BINARY.');
  mkdirSync(output, { recursive: true });
  const isolated = process.env.BOITE_BENCH_CONTEXT_ISOLATED_HOME === '1';
  const isolatedHome = join(output, 'ephemeral-codex-home');
  const authLink = join(isolatedHome, 'auth.json');
  if (isolated) {
    mkdirSync(isolatedHome, { recursive: true });
    if (existsSync(authLink)) throw new Error('Refusing to replace existing isolated auth.json.');
    // Link the existing subscription login without reading or copying credentials.
    symlinkSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), authLink, 'file');
  }
  const harness = await startTestCore().catch(error => {
    if (isolated && existsSync(authLink)) unlinkSync(authLink);
    throw error;
  });
  const rows: any[] = [];
  try {
    const modes = isolated ? ['isolated-home'] : ['baseline', 'task-only'];
    for (let repeat = 0; repeat < 3; repeat++) for (const mode of modes) {
      // Delegate every launch and stop to the real Core procs owner. The proxy only
      // adds process-local config and clears inherited parent-session identifiers.
      const procs = new Proxy(harness.core.procs, { get(target, property) {
        if (property !== 'spawnChild') {
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (key: string, executable: string, args: string[], options: any) => target.spawnChild(key, executable,
          mode !== 'baseline' ? [...args, ...taskOnlyOverrides.flatMap(value => ['-c', value])] : args,
          mode !== 'baseline' ? { ...options, env: { ...options.env, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined,
            ...(isolated ? { CODEX_HOME: isolatedHome } : {}) } } : options);
      } });
      const core = new Proxy(harness.core, { get(target, property) { return property === 'procs' ? procs : Reflect.get(target, property); } }) as Core;
      const model = new BrowserLabCodex(core, binary, process.cwd());
      const row: any = { mode, repeat, prompt, overrides: mode !== 'baseline' ? taskOnlyOverrides : [] };
      const processStarted = performance.now();
      try {
        const metadata = await model.initialize();
        const rpc = (model as any).rpc;
        const { config } = await rpc.request('config/read', { cwd: process.cwd() });
        const skills = await rpc.request('skills/list', { cwds: [process.cwd()], forceReload: false });
        row.ack = { serverVersion: metadata.serverVersion, accountType: metadata.accountType, isolation: metadata.isolation,
          projectDocMaxBytes: config.project_doc_max_bytes, developerInstructionChars: config.developer_instructions?.length ?? 0,
          instructionChars: config.instructions?.length ?? 0, modelInstructionsFilePresent: !!config.model_instructions_file,
          personality: config.personality, skillsMaxContextTokens: config.skills?.max_context_tokens,
          discoveredSkills: skills.data.flatMap((entry: any) => entry.skills).length,
          enabledSkills: skills.data.flatMap((entry: any) => entry.skills).filter((skill: any) => skill.enabled).length,
          clearedSessionIds: mode !== 'baseline', isolatedHome: isolated };
        if (mode !== 'baseline' && (row.ack.skillsMaxContextTokens !== 1 || row.ack.developerInstructionChars !== 0)) throw new Error('Task-only config was not acknowledged.');
        const result = await model.run(prompt, [], async () => { throw new Error('No tools supplied.'); }, 120_000);
        row.config = result.config;
        row.status = result.turn?.status;
        row.threadStartupMs = result.threadStartupMs;
        row.totalMs = result.totalMs;
        row.processTotalMs = performance.now() - processStarted;
        row.usage = result.events.filter((event: any) => event.method === 'thread/tokenUsage/updated').at(-1)?.params?.tokenUsage;
        row.output = result.events.filter((event: any) => event.method === 'item/completed' && event.params.item.type === 'agentMessage').map((event: any) => event.params.item.text).join('\n');
        row.errors = result.events.filter((event: any) => event.method === 'error').map((event: any) => event.params);
        if (row.status !== 'completed' || !row.usage || !row.output.includes('42')) throw new Error('Probe did not complete with usage and correct arithmetic.');
      } catch (error) { row.error = error instanceof Error ? error.stack : String(error); }
      finally {
        await model.close();
        row.processesAfter = harness.core.procs.liveCount(model.processKey);
        row.diagnostics = model.diagnostics;
        rows.push(row);
        writeFileSync(join(output, 'results-private.json'), JSON.stringify(rows, null, 2));
        // Keep customization and full diagnostics in private scratch evidence.
        console.log(JSON.stringify({ mode, repeat, status: row.status, totalMs: row.totalMs, usage: row.usage, processesAfter: row.processesAfter, error: row.error }));
      }
    }
    const summary = modes.map(mode => {
      const selected = rows.filter(row => row.mode === mode);
      return { mode, completed: selected.filter(row => row.status === 'completed').length,
        medianMs: median(selected.map(row => row.totalMs)),
        inputTokens: selected.map(row => row.usage?.total?.inputTokens),
        cachedInputTokens: selected.map(row => row.usage?.total?.cachedInputTokens),
        outputTokens: selected.map(row => row.usage?.total?.outputTokens),
        processesAfter: selected.map(row => row.processesAfter), ack: selected[0]?.ack };
    });
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ summary }));
    if (rows.some(row => row.error || row.processesAfter)) process.exitCode = 1;
  } finally {
    await harness.stop();
    if (isolated && existsSync(authLink)) unlinkSync(authLink);
  }
}

if (import.meta.main) await main();
