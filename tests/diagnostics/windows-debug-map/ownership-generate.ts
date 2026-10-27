import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {sha256} from './generate.ts';
import {mock} from 'bun:test';

export const jobsPath = resolve(import.meta.dir, '../../../packages/core/src/platform/windows/jobs.ts');
export const workerPath = join(dirname(jobsPath), 'jobs-worker.ts');
export const jobsHash = '56a0b7d1d859ae943b837883582d8494c641769545406d20d886e2fb02e0e273';
export const workerHash = 'e0b93fcb4ddb0e9d8155cd203bfa67bcb1ac0715318a23ca2bdb19b2ecdcc29f';
const runtime = pathToFileURL(join(import.meta.dir, 'ownership-trace.ts')).href;
const ledger = pathToFileURL(join(import.meta.dir, 'ownership-ledger.ts')).href;
const reference = pathToFileURL(join(import.meta.dir, 'helper-reference.ts')).href;
const liveFence = pathToFileURL(join(import.meta.dir, 'live-fence-dispatch.ts')).href;
const liveDrain = pathToFileURL(join(import.meta.dir, 'live-root-drain.ts')).href;
const faultRoot = pathToFileURL(join(import.meta.dir, 'fault-root-reference.ts')).href;
const topology = pathToFileURL(join(import.meta.dir, 'target-topology.ts')).href;
function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`ownership substitution must match once: ${before}`);
  return source.replace(before, after);
}
function imports(source: string, original: string): string {
  return source.replace(/from (['"])(\.[^'"\n]+)\1/g, (_, quote: string, name: string) =>
    `from ${quote}${pathToFileURL(resolve(dirname(original), name)).href}${quote}`);
}
export function instrumentJobs(source: string, generatedWorker: string): string {
  if (sha256(source) !== jobsHash) throw new Error('jobs.ts source drift: review and repin ownership trace');
  source = once(source, '    openProcess: (access: number, pid: number): number => asHandle(k32.OpenProcess(access, 0, pid)),',
    '    openProcess: (access: number, pid: number): number => {\n' +
    '      const handle = asHandle(k32.OpenProcess(access, 0, pid));\n' +
    '      ownershipTrace.acquired(handle, pid); return handle;\n    },');
  source = once(source, '      k32.CloseHandle(asPointer(handle));',
    '      const closed = k32.CloseHandle(asPointer(handle));\n' +
    '      const closeError = k32.GetLastError();\n' +
    '      ownershipTrace.closed(handle, closed !== 0, closed !== 0 ? 0 : closeError);');
  source = once(source, "workerEntry(import.meta.url, 'jobs-worker')", JSON.stringify(pathToFileURL(generatedWorker).href) + ', ownershipWorkerOptions()');
  source = once(source, 'function onWorkerMessage(message: JobsWorkerMessage): void {',
    'function onWorkerMessage(message: JobsWorkerMessage): void {\n  ownershipTrace.received(message);');
  source = once(source, "      else if (message.kind === 'packet' && message.handle !== 0) api?.close(message.handle);",
    "      else if (message.kind === 'packet' && message.handle !== 0) {\n" +
    '        ownershipTrace.received(message); api?.close(message.handle);\n      }');
  source = once(source, '    if (read && code[0] === STILL_ACTIVE) return;',
    "    if (read && code[0] === STILL_ACTIVE) {\n" +
    "      ownershipTrace.stage(entry.handle, 'still-active-deferral', {threadId, pid}); return;\n    }");
  source = once(source, '  tracked.set(pid, { threadId, handle, peakMemoryBytes: 0, identity });',
    "  tracked.set(pid, { threadId, handle, peakMemoryBytes: 0, identity });\n" +
    "  ownershipTrace.stage(handle, 'tracked', {threadId, pid, capturedIdentity: identity});\n" +
    "  ownershipMembership(pid);");
  source = once(source, '  ignored.delete(pid);\n  const exe = imageNameOf(api, handle);',
    "  if (ignored.has(pid)) ownershipTrace.event({event: 'ignored-pid-reclassification', threadId, pid, handle});\n" +
    '  ignored.delete(pid);\n  const exe = imageNameOf(api, handle);');
  source = once(source, 'function onJobPacket(message: number, key: number, pid: number, handle = 0): void {',
    "function onJobPacket(message: number, key: number, pid: number, handle = 0): void {\n" +
    "  ownershipTrace.event({event: 'job-packet', message, key, pid, handle});");
  source = once(source, "  api.close(entry.handle);\n  processEventDiagnostic('jobs.exit-emitted',",
    "  ownershipTrace.event({event: 'owned-exit', pid, created: entry.identity?.incarnation ?? null, exitCode: exit.exitCode});\n" +
    '  const referenceJob = threadJobs.get(threadId);\n' +
    '  if (!ownershipTrace.preserve(() => helperReferenceSlot.retain(entry.handle, pid, entry.identity?.incarnation, threadId, exit.exitCode,\n' +
    '    referenceJob ? {threadJob: String(referenceJob.handle), jobKey: referenceJob.key, globalJob: String(globalJob), nestingRefused} : undefined))) api.close(entry.handle);\n' +
    "  processEventDiagnostic('jobs.exit-emitted',");
  source = imports(source, jobsPath);
  return `import {ownershipTrace, ownershipWorkerOptions} from ${JSON.stringify(runtime)};\n` +
    `import {HelperReferenceSlot, type HelperReferenceControl} from ${JSON.stringify(reference)};\n` +
    `import {proveTopology, traceRows} from ${JSON.stringify(topology)};\n` +
    `import {authorizeActiveFence as authorizeLiveFence} from ${JSON.stringify(liveFence)};\n` +
    `import {LiveRootDrainer} from ${JSON.stringify(liveDrain)};\n` +
    `import {FaultRootOwner, validateFaultNativeEvidence} from ${JSON.stringify(faultRoot)};\n` +
    `import {readFileSync} from "node:fs"; import {join} from "node:path";\n` + source +
    '\nexport const ownershipTraceInstalled = true;\n' +
    readFileSync(join(import.meta.dir, 'target-topology-export.txt'), 'utf8') + '\n' +
    readFileSync(join(import.meta.dir, 'helper-reference-export.txt'), 'utf8') + '\n' +
    readFileSync(join(import.meta.dir, 'fault-root-reference-export.txt'), 'utf8') + '\n' +
    readFileSync(join(import.meta.dir, 'live-root-drain-export.txt'), 'utf8');
}
export function instrumentWorker(source: string): string {
  if (sha256(source) !== workerHash) throw new Error('jobs-worker.ts source drift: review and repin ownership trace');
  source = once(source, 'export type JobsWorkerMessage =', 'export type JobsWorkerMessage = (');
  source = once(source, "  | { kind: 'packet'; message: number; key: number; pid: number; handle: number; sequence?: number; workerId?: string };",
    `  | { kind: 'packet'; message: number; key: number; pid: number; handle: number; sequence?: number; workerId?: string }) & {ownershipTrace?: import(${JSON.stringify(ledger)}).Transfer};`);
  source = once(source, '  scope.postMessage(message);',
    '  const transfer = ownershipTrace.sent(message);\n' +
    "  ownershipTrace.event({event: 'packet-send', message, transfer});\n" +
    '  scope.postMessage({...message, ownershipTrace: transfer});\n' +
    "  ownershipTrace.event({event: 'packet-posted', message, transfer});");
  source = once(source, "    const openError = action === 'open' && handle === 0 ? symbols.GetLastError() : 0;",
    "    const openError = action === 'open' && handle === 0 ? symbols.GetLastError() : 0;\n" +
    "    ownershipTrace.event({event: 'worker-packet', message, key, pid, action});\n" +
    "    if (action === 'open') ownershipTrace.acquired(handle, pid);");
  source = once(source, "  send({ kind: 'stopped' });", "  send({ kind: 'stopped' });\n  ownershipTrace.stop();");
  return `import {ownershipTrace} from ${JSON.stringify(runtime)};\n` + imports(source, workerPath);
}
export interface PreparedOwnership {directory: string; jobs: string; worker: string; preload: string; hashes: Record<string, string>}
export function prepareOwnership(directory: string): PreparedOwnership {
  if (!isAbsolute(directory)) throw new Error('ownership artifact directory must be absolute');
  mkdirSync(directory, {recursive: true});
  const jobs = join(directory, 'jobs.ts'), worker = join(directory, 'jobs-worker.ts'), preload = join(directory, 'preload.ts');
  const originalJobs = readFileSync(jobsPath, 'utf8'), originalWorker = readFileSync(workerPath, 'utf8');
  const generatedJobs = instrumentJobs(originalJobs, worker), generatedWorker = instrumentWorker(originalWorker);
  writeFileSync(jobs, generatedJobs); writeFileSync(worker, generatedWorker);
  const installer = pathToFileURL(fileURLToPath(import.meta.url)).href;
  writeFileSync(preload, `import {installOwnership} from ${JSON.stringify(installer)};\n` +
    `await installOwnership(${JSON.stringify(jobs)});\n`);
  const hashes: Record<string, string> = {
    [jobsPath]: sha256(originalJobs), [workerPath]: sha256(originalWorker),
    [jobs]: sha256(generatedJobs), [worker]: sha256(generatedWorker),
    [preload]: sha256(readFileSync(preload)),
  };
  for (const name of ['ownership-generate.ts', 'ownership-ledger.ts', 'ownership-trace.ts', 'target-topology-export.txt', 'helper-reference.ts', 'helper-reference-export.txt', 'fault-root-reference.ts', 'fault-root-reference-export.txt', 'live-root-fence.ts', 'live-root-drain.ts', 'live-root-drain-export.txt', 'live-fence-dispatch.ts', 'stdio-root-fence.ts', 'stdout-write-fence.ts', 'stdout-zero-fence.ts', 'stdout-byte-fence.ts', 'stdout-close-fence.ts'])
    hashes[join(import.meta.dir, name)] = sha256(readFileSync(join(import.meta.dir, name)));
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify({jobsPath, workerPath, hashes}, null, 2) + '\n');
  return {directory, jobs, worker, preload, hashes};
}
export async function installOwnership(generatedJobs: string): Promise<boolean> {
  if (process.env.BOITE_TEST_DEBUG_MAP !== '1' || process.env.BOITE_DEBUG_MAP_OWNERSHIP !== '1') return false;
  if (!isAbsolute(generatedJobs)) throw new Error('generated ownership jobs path must be absolute');
  const generated = await import(pathToFileURL(generatedJobs).href);
  mock.module(jobsPath, () => generated);
  const canonical = await import(pathToFileURL(jobsPath).href);
  if (canonical.ownershipTraceInstalled !== true || canonical.assignToThreadJob !== generated.assignToThreadJob)
    throw new Error('canonical Windows jobs ownership interception failed');
  const {ownershipTrace} = await import('./ownership-trace.ts');
  ownershipTrace.event({event: 'canonical-interception-verified', canonical: jobsPath, generatedJobs});
  return true;
}

export async function verifyOwnershipPlatform(): Promise<void> {
  const canonical = await import(pathToFileURL(jobsPath).href);
  const {platform} = await import('../../../packages/core/src/platform/windows/index.ts');
  if (canonical.ownershipTraceInstalled !== true || platform.attach !== canonical.assignToThreadJob)
    throw new Error('Windows ProcessPlatform bypassed ownership interception');
  const {ownershipTrace} = await import('./ownership-trace.ts');
  ownershipTrace.event({event: 'interception-verified', canonical: jobsPath, platformAttach: true});
}

/** Resolve only the installed hash-pinned diagnostic copy, never a new owner. */
export async function ownedMembershipReader(): Promise<(pid: number) => Omit<import('./target-topology.ts').Membership, 'role'> | null> {
  const canonical = await import(pathToFileURL(jobsPath).href);
  if (canonical.ownershipTraceInstalled !== true || typeof canonical.ownershipMembership !== 'function')
    throw new Error('owned membership diagnostic export unavailable');
  return canonical.ownershipMembership;
}

export function ownershipTestArgs(preload: string, file: string): string[] {
  // Bun resolves a package script if --preload precedes the test subcommand.
  return ['test', '--preload', preload, file, '--timeout', '90000'];
}

export async function ownedJobReader(): Promise<(threadId: string) => import('./helper-job.ts').JobAccounting | null> {
  const canonical = await import(pathToFileURL(jobsPath).href);
  if (canonical.ownershipTraceInstalled !== true || typeof canonical.ownershipJobAccounting !== 'function')
    throw new Error('owned job accounting diagnostic export unavailable');
  return canonical.ownershipJobAccounting;
}

export async function ownedHelperReference(): Promise<import('./helper-reference.ts').HelperReferenceControl> {
  const canonical = await import(pathToFileURL(jobsPath).href);
  if (canonical.ownershipTraceInstalled !== true || !canonical.ownershipHelperReference)
    throw new Error('owned helper reference diagnostic export unavailable');
  return canonical.ownershipHelperReference;
}

export async function ownedFaultRootReference(compiler:string,nonce:string,directory:string,trace:string,controlDirectory:string):Promise<import('./fault-root-reference.ts').FaultRootOwner> {
 const canonical=await import(pathToFileURL(jobsPath).href);
 if(canonical.ownershipTraceInstalled!==true||typeof canonical.ownershipFaultRootReference!=='function')throw new Error('fault root owner export missing');
 return canonical.ownershipFaultRootReference(compiler,nonce,directory,trace,controlDirectory);
}

export async function ownedLiveRootDrainer(compiler:string,nonce:string,directory:string,trace:string):Promise<import('./live-root-drain.ts').LiveRootDrainer> {
 const canonical=await import(pathToFileURL(jobsPath).href);
 if(canonical.ownershipTraceInstalled!==true||typeof canonical.ownershipDrainLiveRoot!=='function')throw new Error('live harness drain owner export missing');
 return canonical.ownershipDrainLiveRoot(compiler,nonce,directory,trace);
}
