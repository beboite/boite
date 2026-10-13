/**
 * Offline synthetic startup timing through the real RPC server and Codex stdio driver.
 * bun bench/agent-startup.ts --offline --runs 7 --delay-ms 150 --output /tmp/startup.json
 * No installed agent, login, network model call, window or permanent repository is used.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attachment, ProcessRecord, RpcParams, Turn } from '../packages/contracts/src/index.ts';
import { createCodexDriver } from '../packages/core/src/drivers/codex.ts';
import { setDriver } from '../packages/core/src/drivers/index.ts';
import { startTestCore, waitFor, type TestCore } from '../packages/core/test/harness.ts';
import { countLogLines, readScriptedLog, writeScriptedProvider } from '../packages/core/test/scripted-provider.ts';
import { median, percentile } from './lib/report.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../packages/core/test/fixtures/codex-server.ts', import.meta.url));
const PROVIDER = 'startup-benchmark-fixture';
const PROMPT = 'Offline startup timing fixture';

interface Options { runs: number; delayMs: number; output?: string; worktrees: boolean }
interface Sample {
  index: number;
  workspace: 'directory' | 'sparse-worktree';
  strategy: 'cold' | 'prepared';
  setupMs: number;
  prepareRequestMs: number | null;
  prepareNativeReadyMs: number | null;
  clickToThreadCreatedMs: number;
  clickToAcceptanceMs: number;
  turnsStartRpcMs: number;
  clickToFirstAssistantTextMs: number;
  clickToFinishedMs: number;
  nativeInitializeBeforeSend: number;
  nativeInitializeAfterSend: number;
  nativeProcessesBeforeSend: number;
  nativeProcessesAfterSend: number;
  allTracedProcesses: number;
  retainedNativeBeforeCleanup: number;
  remainingProcessesAfterCleanup: number;
}

function invariant(held: unknown, message: string): asserts held {
  if (!held) throw new Error(message);
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('bun bench/agent-startup.ts --offline [--runs 7] [--delay-ms 150] [--no-worktree] [--output /tmp/startup.json]');
    process.exit(0);
  }
  invariant(args.includes('--offline'), 'this synthetic benchmark is opt-in: pass --offline');
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--offline' || arg === '--no-worktree') continue;
    invariant(['--runs', '--delay-ms', '--output'].includes(arg), `unknown option ${arg}`);
    const value = args[++index];
    invariant(value && !value.startsWith('--'), `${arg} needs a value`);
    values.set(arg, value);
  }
  const runs = Number(values.get('--runs') ?? 7);
  const delayMs = Number(values.get('--delay-ms') ?? 150);
  invariant(Number.isSafeInteger(runs) && runs > 0, '--runs must be a positive integer');
  invariant(Number.isSafeInteger(delayMs) && delayMs >= 0, '--delay-ms must be a nonnegative integer');
  return { runs, delayMs, output: values.get('--output'), worktrees: !args.includes('--no-worktree') };
}

async function git(harness: TestCore, cwd: string, ...args: string[]): Promise<void> {
  const child = harness.core.procs.spawnPiped('startup-benchmark-git', 'git', args, { cwd, agentRoot: false });
  child.proc.stdin.end();
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.proc.stdout).text(), new Response(child.proc.stderr).text()]);
  invariant(code === 0, `fixture git ${args[0]} failed (${code}): ${stderr}`);
}

async function setup(options: Options, worktree: boolean) {
  const started = performance.now();
  const harness = await startTestCore({ settings: { warmProcessMinutes: 0 } });
  const nativeReady = new Map<string, Promise<void>>();
  const driver = createCodexDriver();
  const prepare = driver.prepare!;
  driver.prepare = (ctx, settings) => {
    const ready = prepare(ctx, settings);
    nativeReady.set(ctx.thread.id, ready);
    return ready;
  };
  // Isolate the first prompt's startup from automatic title model calls.
  driver.title = undefined;
  const restore = setDriver('codex-appserver', driver);
  const records: ProcessRecord[] = [];
  const untrace = harness.core.bus.onAny((event, payload) => { if (event === 'process.started') records.push(payload as ProcessRecord); });
  try {
    process.env.CODEX_FAKE_LOG = join(harness.dataDir, 'native.log');
    process.env.CODEX_FAKE_SLOW_START = String(options.delayMs);
    const client = await harness.connect();
    writeScriptedProvider(harness.dataDir, FIXTURE, {
      id: PROVIDER, schemaVersion: 1, name: 'Offline startup fixture', shortName: 'Fixture',
      protocol: 'codex-appserver', roots: ['{isolationDir}'], auth: { kind: 'none' },
      models: [{ id: 'fake-codex', name: 'Scripted model', default: true }],
      capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: false, resume: true },
    });
    const providers = await client.call('providers.reload', {});
    invariant(providers.rejected.length === 0 && providers.loaded.some(provider => provider.id === PROVIDER && provider.available), 'scripted provider was not available');
    const projectPath = join(harness.dataDir, 'workspace');
    if (worktree) {
      // Borrow existing objects into a disposable clone. No commit, push, source
      // repository worktree registration or full source checkout is needed.
      await git(harness, harness.dataDir, 'clone', '--quiet', '--shared', '--no-checkout', ROOT, projectPath);
      await git(harness, projectPath, 'config', 'core.sparseCheckout', 'true');
      await writeFile(join(projectPath, '.git', 'info', 'sparse-checkout'), '/__offline_startup_fixture__/\n');
    } else await mkdir(projectPath);
    const project = await client.call('projects.add', { path: projectPath, name: 'Offline fixture' });
    const account = await client.call('accounts.add', { providerId: PROVIDER, label: 'Fixture', useDefaultLocation: true });
    const selection: RpcParams<'drafts.prepare'> = {
      projectId: project.id, providerId: PROVIDER, accountId: account.id, model: 'fake-codex',
      preparationId: `bench_${randomUUID().replaceAll('-', '')}`,
      ...(worktree ? { worktree: { branch: 'bench/startup' } } : {}),
    };
    const log = () => readScriptedLog(join(harness.dataDir, 'native.log'));
    const nativeProcesses = () => records.filter(record => record.commandLine?.includes(FIXTURE)).length;
    let cleaned = false;
    const cleanup = async (): Promise<number> => {
      if (cleaned) return 0;
      cleaned = true;
      try { await harness.stop(); }
      finally { untrace(); restore(); }
      return harness.core.procs.liveThreads().reduce((count, id) => count + harness.core.procs.liveCount(id), 0);
    };
    return { harness, client, selection, nativeReady, nativeProcesses, records, log, cleanup, setupMs: performance.now() - started };
  } catch (error) {
    try { await harness.stop(); }
    finally { untrace(); restore(); }
    throw error;
  }
}

async function once(options: Options, index: number, strategy: Sample['strategy'], worktree: boolean): Promise<Sample> {
  const fixture = await setup(options, worktree);
  const { client, selection, harness } = fixture;
  const { preparationId, ...creation } = selection;
  try {
    let prepareRequestMs: number | null = null;
    let prepareNativeReadyMs: number | null = null;
    if (strategy === 'prepared') {
      const begin = performance.now();
      const reserved = await client.call('drafts.prepare', selection);
      prepareRequestMs = performance.now() - begin;
      const ready = fixture.nativeReady.get(reserved.threadId);
      invariant(ready, 'draft reservation did not start native preparation');
      await ready;
      prepareNativeReadyMs = performance.now() - begin;
      invariant(!harness.core.journal.getThread(reserved.threadId), 'preparation published a conversation before Send');
    }
    invariant(!fixture.log().includes('turn/start'), 'preparation submitted a native prompt');
    const nativeInitializeBeforeSend = countLogLines(fixture.log(), 'initialize');
    const nativeProcessesBeforeSend = fixture.nativeProcesses();
    invariant(nativeInitializeBeforeSend === (strategy === 'prepared' ? 1 : 0), 'unexpected pre-send native initialize count');
    const click = performance.now();
    const thread = await client.call('threads.create', { ...creation, title: 'Offline startup fixture', subscribe: true, ...(strategy === 'prepared' ? { preparationId } : {}) });
    const clickToThreadCreatedMs = performance.now() - click;
    let firstText: number | undefined;
    let finished: { at: number; turn: Turn } | undefined;
    const assistantMessages = new Set<string>();
    const subscriptions = [
      client.on('message.started', message => { if (message.threadId === thread.id && message.role === 'assistant') assistantMessages.add(message.id); }),
      client.on('message.delta', event => { if (event.threadId === thread.id && event.text.length > 0 && assistantMessages.has(event.messageId)) firstText ??= performance.now(); }),
      client.on('message.part', event => { if (event.threadId === thread.id && event.part.type === 'text' && event.part.text.length > 0 && assistantMessages.has(event.messageId)) firstText ??= performance.now(); }),
      client.on('turn.finished', turn => { if (turn.threadId === thread.id) finished = { at: performance.now(), turn }; }),
    ];
    try {
      const send = performance.now();
      const accepted = await client.call('turns.start', { threadId: thread.id, prompt: PROMPT });
      const acceptedAt = performance.now();
      await waitFor(() => finished !== undefined, options.delayMs + 10_000);
      invariant(finished && finished.turn.id === accepted.id && finished.turn.status === 'done', `fixture turn failed: ${JSON.stringify(finished?.turn.error)}`);
      invariant(firstText !== undefined, 'no assistant text reached the subscribed client');
      const sample: Sample = {
        index, workspace: worktree ? 'sparse-worktree' : 'directory', strategy, setupMs: fixture.setupMs,
        prepareRequestMs, prepareNativeReadyMs, clickToThreadCreatedMs,
        clickToAcceptanceMs: acceptedAt - click, turnsStartRpcMs: acceptedAt - send,
        clickToFirstAssistantTextMs: firstText - click, clickToFinishedMs: finished.at - click,
        nativeInitializeBeforeSend, nativeInitializeAfterSend: countLogLines(fixture.log(), 'initialize'),
        nativeProcessesBeforeSend, nativeProcessesAfterSend: fixture.nativeProcesses(),
        allTracedProcesses: fixture.records.length, retainedNativeBeforeCleanup: harness.core.procs.liveCount(thread.id),
        remainingProcessesAfterCleanup: 0,
      };
      invariant(sample.nativeInitializeAfterSend === 1 && sample.nativeProcessesAfterSend === 1, 'sending created duplicate native processes');
      sample.remainingProcessesAfterCleanup = await fixture.cleanup();
      invariant(sample.remainingProcessesAfterCleanup === 0, 'fixture cleanup left live processes');
      return sample;
    } finally { for (const unsubscribe of subscriptions) unsubscribe(); }
  } finally { await fixture.cleanup(); }
}

function frameBytes(method: string, params: unknown): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'utf8');
}

async function attachments(options: Options) {
  const fixture = await setup(options, false);
  const { client, harness } = fixture;
  // A real PNG, and a 256 KiB text file. The native fixture sees the image URL
  // and echoes the file's local reference; both are verified after each send.
  const image: Attachment = { kind: 'image', name: 'pixel.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=' };
  const fileBytes = Buffer.from('offline attachment fixture\n'.repeat(10_500)).subarray(0, 256 * 1024);
  const file: Attachment = { kind: 'file', name: 'fixture.txt', mimeType: 'text/plain', data: fileBytes.toString('base64') };
  const input = [image, file];
  const cases: { strategy: 'inline' | 'uploaded'; turnsStartFrameBytes: number; preSendUploadFrameBytes: number; totalAttachmentRequestFrameBytes: number; preSendUploadMs: number; clickToAcceptanceMs: number; preservedJournalBytes: boolean; preservedNativeImage: boolean; preservedFilePathBytes: boolean }[] = [];
  try {
    for (const strategy of ['inline', 'uploaded'] as const) {
      const { preparationId: _, ...creation } = fixture.selection;
      const thread = await client.call('threads.create', { ...creation, title: 'Attachment fixture', subscribe: true });
      const ids: string[] = [];
      const uploadBegin = performance.now();
      let preSendUploadFrameBytes = 0;
      if (strategy === 'uploaded') for (const attachment of input) {
        preSendUploadFrameBytes += frameBytes('attachments.upload', { attachment });
        ids.push((await client.call('attachments.upload', { attachment })).id);
      }
      const preSendUploadMs = strategy === 'uploaded' ? performance.now() - uploadBegin : 0;
      const params: RpcParams<'turns.start'> = { threadId: thread.id, prompt: 'Inspect attached fixtures', attachments: strategy === 'inline' ? input : input.map(attachment => ({ ...attachment, data: '' })), ...(strategy === 'uploaded' ? { attachmentIds: ids } : {}) };
      let finished: Turn | undefined;
      const unsubscribe = client.on('turn.finished', turn => { if (turn.threadId === thread.id) finished = turn; });
      try {
        const previousLogLength = fixture.log().length;
        const click = performance.now();
        await client.call('turns.start', params);
        const clickToAcceptanceMs = performance.now() - click;
        await waitFor(() => finished !== undefined, options.delayMs + 10_000);
        invariant(finished?.status === 'done', 'attachment fixture turn failed');
        const messages = harness.core.journal.listMessages(thread.id);
        const user = messages.find(message => message.role === 'user');
        invariant(user, 'no persisted user message');
        for (const attachment of input) invariant(user.parts.some(part => (part.type === 'image' || part.type === 'file') && part.type === attachment.kind && (part.type === 'file' ? part.name : part.alt) === attachment.name && part.mimeType === attachment.mimeType && part.data === attachment.data), `journal lost ${attachment.kind} bytes`);
        invariant(fixture.log().slice(previousLogLength).includes(`image data:image/png;base64,${image.data}`), 'native image payload was lost');
        const reply = messages.filter(message => message.role === 'assistant').flatMap(message => message.parts).filter(part => part.type === 'text').map(part => part.text).join('');
        const line = reply.split('\n').find(text => text.startsWith('{"name":"fixture.txt"'));
        invariant(line, 'native prompt lost the file reference');
        const reference = JSON.parse(line) as { path: string };
        invariant(Buffer.from(await Bun.file(reference.path).arrayBuffer()).equals(fileBytes), 'native file path contains changed bytes');
        const turnsStartFrameBytes = frameBytes('turns.start', params);
        cases.push({ strategy, turnsStartFrameBytes, preSendUploadFrameBytes, totalAttachmentRequestFrameBytes: preSendUploadFrameBytes + turnsStartFrameBytes, preSendUploadMs, clickToAcceptanceMs, preservedJournalBytes: true, preservedNativeImage: true, preservedFilePathBytes: true });
        if (ids.length) await client.call('attachments.release', { ids });
      } finally { unsubscribe(); }
    }
    const remainingProcessesAfterCleanup = await fixture.cleanup();
    invariant(remainingProcessesAfterCleanup === 0, 'attachment fixture cleanup left live processes');
    return { decodedInputBytes: input.map(attachment => ({ kind: attachment.kind, bytes: Buffer.byteLength(attachment.data, 'base64'), sha256: createHash('sha256').update(Buffer.from(attachment.data, 'base64')).digest('hex') })), frameDefinition: 'Uncompressed JSON-RPC request UTF-8 bytes, canonical numeric request ID 1; upload responses, release and other RPCs excluded.', cases, remainingProcessesAfterCleanup };
  } finally { await fixture.cleanup(); }
}

async function main() {
  const options = parseOptions();
  for (const [key, value] of Object.entries(process.env)) {
    invariant(!(value === '1' && (key.startsWith('BOITE_E2E_') || key === 'BOITE_BENCH_CLAUDE' || key === 'BOITE_BENCH_HOST_AGENTS')), `disable live opt-in ${key} before this offline benchmark`);
    if (key.startsWith('CODEX_FAKE_')) delete process.env[key];
  }
  const samples: Sample[] = [];
  // Sequential runs retain the harness's fresh environment and inherit agent resource caps.
  for (let index = 0; index < options.runs; index++) for (const worktree of options.worktrees ? [false, true] : [false]) {
    for (const strategy of index % 2 === 0 ? ['cold', 'prepared'] as const : ['prepared', 'cold'] as const) {
      const sample = await once(options, index, strategy, worktree);
      samples.push(sample);
      console.log(`sample ${index + 1} ${sample.workspace} ${strategy}: acceptance=${sample.clickToAcceptanceMs.toFixed(2)} ms first-text=${sample.clickToFirstAssistantTextMs.toFixed(2)} ms finish=${sample.clickToFinishedMs.toFixed(2)} ms initialize=${sample.nativeInitializeBeforeSend}/${sample.nativeInitializeAfterSend}`);
    }
  }
  const metrics = ['clickToThreadCreatedMs', 'clickToAcceptanceMs', 'turnsStartRpcMs', 'clickToFirstAssistantTextMs', 'clickToFinishedMs', 'prepareRequestMs', 'prepareNativeReadyMs'] as const;
  const groups = [...new Set(samples.map(sample => `${sample.workspace}/${sample.strategy}`))].map(name => {
    const selected = samples.filter(sample => `${sample.workspace}/${sample.strategy}` === name);
    return { name, samples: selected.length, metrics: Object.fromEntries(metrics.map(metric => {
      const values = selected.flatMap(sample => sample[metric] === null ? [] : [sample[metric] as number]);
      return [metric, values.length ? { medianMs: median(values), p95Ms: percentile(values, 0.95) } : null];
    })), nativeInitializeTotal: selected.reduce((sum, sample) => sum + sample.nativeInitializeAfterSend, 0), nativeProcessesTotal: selected.reduce((sum, sample) => sum + sample.nativeProcessesAfterSend, 0) };
  });
  const attachmentFrames = await attachments(options);
  const report = {
    schemaVersion: 1, at: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, bun: Bun.version },
    synthetic: true, offline: true, injectedThreadStartDelayMs: options.delayMs, runsPerStrategy: options.runs,
    definitions: {
      cold: 'Send starts threads.create and turns.start with no native process before the click.',
      prepared: 'drafts.prepare reserves an unpublished workspace; the real driver prepare promise is awaited until the fake native session is ready before Send.',
      acceptance: 'Click to turns.start RPC response, including conversation creation/adoption.',
      firstAssistant: 'First nonempty assistant text event received by the subscribed client, rather than an empty message placeholder.',
      end: 'turn.finished event received by the client with status done.',
      worktree: 'Disposable local shared clone with no source files selected by sparse checkout; actual git worktree and branch creation, without commits or changes in the source repository.',
    },
    limitations: ['Synthetic local fixture timing does not predict real provider, network or model performance.', 'Each sample has a fresh core/data directory, but all samples share one Bun process and filesystem caches; this is a cold native process comparison, not cold OS or module startup.', 'Automatic title model calls are disabled to isolate first-prompt startup.', 'Prepared native startup and attachment transmission move work before Send; they still cost time and upload bytes.', 'Sparse worktrees measure Git metadata and empty-checkout work, not copying a full project. Normal checkpoint costs remain within first-assistant and completion timing.', 'No GUI, network latency or compression is measured.'],
    groups, samples, attachmentFrames,
  };
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  } else console.log(JSON.stringify(report, null, 2));
  console.log(`STARTUP_BENCH_OK synthetic=true samples=${samples.length} nativeInitializes=${samples.reduce((sum, sample) => sum + sample.nativeInitializeAfterSend, 0)} cleanupLive=0 attachmentInputsPreserved=true`);
}

if (import.meta.main) await main();
