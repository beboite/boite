import type {Captured} from './capture.ts';

export type WorkerMode = 'exited' | 'waiting';
export interface WorkerIdentity {pid: number; created: string}
export interface WorkerFrame {
  phase: string; mode: WorkerMode; nonce: string; pid: number; processCreated: string;
  mainTid: number; tid: number; threadCreated: string; body: number; ready: number; now: number; released: number;
  pre: number; post: number; code: number; status: string; absent: number; observerClosed: number;
  threadClosed: number; callbackError: number; path: string;
}
export interface WorkerReport {
  protocolValid: boolean; prerequisites: boolean; reproducible: boolean; comparisonConclusive: boolean;
  bodyResult: number | null; frames: WorkerFrame[]; productionAccepted: false; causeConfirmed: false;
  outcome?: string; error?: string;
}
const fields = ['phase', 'mode', 'nonce', 'pid', 'process-created', 'main-tid', 'tid', 'thread-created', 'body',
  'ready', 'now', 'released', 'pre', 'post', 'code', 'status', 'absent', 'observer-closed', 'thread-closed', 'callback-error', 'path'];
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`worker lifetime: ${message}`);
}
export function parseWorkerFrame(line: string): WorkerFrame {
  const tokens = line.replace(/\r$/, '').split(' ');
  requireValue(tokens.shift() === 'worker-lifetime' && tokens.length === fields.length, 'frame size');
  const values: Record<string, string> = {};
  for (const [i, token] of tokens.entries()) {
    const split = token.indexOf('=');
    requireValue(split > 0 && token.slice(0, split) === fields[i], 'frame fields/order');
    values[fields[i]!] = token.slice(split + 1);
  }
  const n = (key: string) => {
    requireValue(/^-?\d+$/.test(values[key]!), `integer ${key}`);
    const value = Number(values[key]); requireValue(Number.isSafeInteger(value), `safe integer ${key}`); return value;
  };
  requireValue(values.mode === 'exited' || values.mode === 'waiting', 'mode');
  requireValue(/^[a-f0-9]{32}$/.test(values.nonce!), 'nonce');
  for (const key of ['process-created', 'thread-created']) requireValue(/^[1-9]\d{0,19}$/.test(values[key]!), key);
  requireValue(/^0x[\da-f]{8}$/.test(values.status!), 'status');
  return {phase: values.phase!, mode: values.mode, nonce: values.nonce!, pid: n('pid'), processCreated: values['process-created']!,
    mainTid: n('main-tid'), tid: n('tid'), threadCreated: values['thread-created']!, body: n('body'), ready: n('ready'), now: n('now'),
    released: n('released'), pre: n('pre'), post: n('post'), code: n('code'), status: values.status!, absent: n('absent'),
    observerClosed: n('observer-closed'), threadClosed: n('thread-closed'), callbackError: n('callback-error'), path: values.path!};
}
/** Successful non-map prerequisites are independent from the deliberately fatal
 * absence gates. A late disappearance never rewrites the body's original code. */
export function workerPrerequisites(result: Captured, marker: string): string {
  requireValue(/^[A-Za-z0-9_-]+$/.test(marker), 'marker');
  const root = result.out.match(new RegExp(`^inspect-start=${marker}\\.generation-0 pid=(\\d+)\\r?$`, 'm'))?.[1];
  requireValue(root && Number(root) > 0, 'root marker identity');
  const assigned = result.err.split(/\r?\n/).filter(line => /^private-map pid=/.test(line));
  requireValue(assigned.length === 1 && assigned[0] === `private-map pid=${root} set=0x00000000`, 'exact root assignment');
  requireValue(result.err.includes(`debug-create pid=${root} job=1 nonbreakaway=1 package/capability=1 lpac=1 attribute=0x00000000`), 'root confinement');
  for (let depth = 0; depth < 3; depth++) {
    const label = `${marker}.generation-${depth}`;
    requireValue(result.out.includes(`${label} appcontainer=1 in-job=1 routing=${depth === 0 ? 1 : 0}`) &&
      result.out.includes(`${label} ambient-denial=5`) && result.out.includes(`${label} host-debug-control=0 known=1`) &&
      new RegExp(`${label.replaceAll('.', '\\.')} inspect-exit=[01] child-exit=[01] forced=0\\r?\\n`).test(result.out), 'marker/descendant boundary/normal exit');
  }
  for (const role of ['launch', 'boundary']) {
    const lines = result.err.split(/\r?\n/).filter(l => l.startsWith(`token-cleanup role=${role} `));
    requireValue(lines.length === 1 && lines[0] === `token-cleanup role=${role} pid=${root} success=1 error=0`, 'token closure');
  }
  for (const object of ['root-thread', 'root-process', 'job', 'link', 'map'])
    requireValue(result.err.includes(`cleanup close=${object} closed=1 error=0`), `owned ${object} closure`);
  requireValue(result.err.includes('cleanup job-active=0'), 'private target job empty');
  for (const action of ['station-restore', 'desktop', 'station'])
    requireValue(result.err.includes(`window-cleanup action=${action} success=1 error=0`), 'window cleanup');
  for (let i = 0; i < 3; i++) requireValue(result.err.includes(`stream-cleanup index=${i} success=1 error=0`), 'stream cleanup');
  const before = result.err.match(/^caller snapshot=before (.+)\r?$/m)?.[1]?.replace(/\r$/, '');
  requireValue(before && before.endsWith('unchanged=1') && before === result.err.match(/^caller snapshot=after (.+)\r?$/m)?.[1]?.replace(/\r$/, ''), 'caller state');
  requireValue(!/map-swap |map-retire |target-creator-|creator-ready |debug-event /.test(result.err), 'DIRECT settings');
  requireValue(/^owned-observers enabled=1 object-queries=[1-9]\d* handle-snapshots=[1-9]\d*\r?$/m.test(result.err), 'owned observers');
  requireValue(/^cleanup map-open=0x(?:00000000|c0000034) absent=[01]\r?$/m.test(result.err) &&
    /^cleanup map-eventual-open=0x(?:00000000|c0000034) absent=[01] elapsed-ms=\d+ attempts=\d+ limit-ms=2000\r?$/m.test(result.err) &&
    /^cleanup checkpoint-map-open=0x(?:00000000|c0000034) absent=[01] closed=1 error=0 wall-ms=\d+/m.test(result.err), 'original map gates completed');
  const names = [...result.err.matchAll(/^private-map path=(\S+) create=0x00000000\r?$/gm)];
  requireValue(names.length === 1, 'owned name creation');
  const path = names[0]![1]!;
  requireValue(path.replace(/^\\Sessions\\\d+(?=\\BaseNamedObjects\\)/, '') === String.raw`\BaseNamedObjects\boite.route.${result.pid}`, 'owned exact name');
  return path;
}
export function validateWorkerLifetime(result: Captured, expected: {mode: WorkerMode; nonce: string; helper: WorkerIdentity; marker: string}): WorkerReport {
  const report: WorkerReport = {protocolValid: false, prerequisites: false, reproducible: false, comparisonConclusive: false,
    bodyResult: null, frames: [], productionAccepted: false, causeConfirmed: false};
  try {
    requireValue(!result.timedOut && result.code !== null && result.pid === expected.helper.pid, 'captured helper completion');
    report.frames = result.err.split(/\r?\n/).filter(l => l.startsWith('worker-lifetime')).map(parseWorkerFrame);
    const phases = expected.mode === 'exited' ? ['start', 'ready', 'exited-held', 'exited-closed', 'complete']
      : ['start', 'ready', 'waiting', 'released-held', 'released-closed', 'complete'];
    requireValue(report.frames.map(f => f.phase).join(',') === phases.join(','), 'phase order/completion');
    const [start, ready] = report.frames as [WorkerFrame, WorkerFrame, ...WorkerFrame[]];
    requireValue(start.pid === expected.helper.pid && start.processCreated === expected.helper.created && start.nonce === expected.nonce,
      'captured helper identity/nonce');
    requireValue(start.tid > 0 && start.mainTid > 0 && start.mainTid !== start.tid && start.ready === 0 && start.body === -1 && start.path === '-', 'thread start identity');
    requireValue(start.status === '0x00000000' && start.absent === 0, 'start is not an observation');
    requireValue(start.pre === 258 && start.post === 258 && start.code === 259 && start.released === 0 && start.threadClosed === 0, 'suspended start');
    report.bodyResult = ready.body;
    requireValue(ready.ready >= start.now && ready.now >= ready.ready && result.code === ready.body, 'immutable body result');
    let lastNow = start.now, release = 0, liveUntil = ready.now;
    for (const frame of report.frames) {
      requireValue(frame.mode === expected.mode && frame.nonce === start.nonce && frame.pid === start.pid && frame.processCreated === start.processCreated &&
        frame.tid === start.tid && frame.mainTid === start.mainTid && frame.threadCreated === start.threadCreated, 'process/thread identity changed');
      requireValue(frame.callbackError === 0 && frame.observerClosed === 1 && frame.now >= lastNow, 'callback/observation/order'); lastNow = frame.now;
      if (frame.phase === 'start') continue;
      requireValue(frame.ready === ready.ready && frame.body === ready.body && frame.now < ready.ready + 5000, 'body/deadline changed');
      const live = frame.phase === 'ready' || frame.phase === 'waiting';
      const closed = frame.phase.endsWith('-closed') || frame.phase === 'complete';
      requireValue(frame.pre === (live ? 258 : 0) && frame.post === frame.pre && frame.code === (live ? 259 : 0) && frame.threadClosed === +closed,
        'early exit/join/exit code/known handle closure');
      if (live) {
        requireValue(frame.released === 0 && frame.now < ready.ready + 3000, 'early release/park deadline'); liveUntil = frame.now;
      } else {
        requireValue(frame.released >= liveUntil && frame.released < ready.ready + 3000 && frame.released <= frame.now, 'release deadline/order');
        requireValue(release === 0 || frame.released === release, 'release changed'); release = frame.released;
      }
      if (frame.phase === 'waiting' || (expected.mode === 'exited' && frame.phase === 'exited-held'))
        requireValue(frame.now >= ready.ready + 100, 'matched comparison sample time');
      if (frame.phase === 'complete') requireValue(frame.status === '0x00000000' && frame.absent === 0, 'completion is not an observation');
      if (frame.phase !== 'complete') requireValue((frame.status === '0x00000000' && frame.absent === 0) ||
        (frame.status === '0xc0000034' && frame.absent === 1), 'observation status');
    }
    const path = workerPrerequisites(result, expected.marker); report.prerequisites = true;
    requireValue(report.frames.slice(1).every(f => f.path === path), 'observed owned name changed');
    const readyLine = result.err.indexOf('worker-lifetime phase=ready ');
    requireValue(result.err.indexOf('worker-lifetime phase=start ') < result.err.indexOf('caller snapshot=before '), 'body started before captured thread proof');
    requireValue(readyLine > result.err.indexOf('caller snapshot=after ') && readyLine > result.err.indexOf('owned-observers enabled='), 'READY before full body cleanup');
    report.reproducible = ready.absent === 0;
    const held = report.frames.find(f => f.phase.endsWith('-held'))!, closed = report.frames.find(f => f.phase.endsWith('-closed'))!;
    const waiting = report.frames.find(f => f.phase === 'waiting');
    requireValue(!held.absent || closed.absent === 1, 'name reappeared after known thread close');
    report.protocolValid = true; report.comparisonConclusive = report.reproducible && (!waiting || waiting.absent === 0);
    report.outcome = !report.comparisonConclusive ? 'inconclusive-live-baseline' : held.absent ? 'absent-after-thread-return'
      : closed.absent ? 'absent-after-known-thread-close' : 'retained-after-thread-close';
  } catch (error) {report.error = String(error);}
  return report;
}
