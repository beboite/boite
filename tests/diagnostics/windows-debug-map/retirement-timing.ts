import type {Captured} from './capture.ts';

export type RetirementMode = 'live' | 'exited';
export interface RetirementFrame {
  phase: string; mode: RetirementMode; nonce: string; helper: number; helperCreated: string;
  root: number; created: string; tid: number; threadOwner: number; threadCreated: string; result: number;
  started: number; deadline: number; now: number; previous: number; closed: number; error: number;
}
export interface RetirementReport {
  mode: RetirementMode; protocolValid: boolean; prerequisites: boolean; reproducesBaseline: boolean;
  cleanupGatesPassed: boolean; outcome?: string; error?: string; frames: RetirementFrame[];
  productionAccepted: false; causeConfirmed: false;
}
const fields = ['phase', 'mode', 'nonce', 'helper', 'helper-created', 'root', 'created', 'tid', 'thread-owner', 'thread-created',
  'result', 'started', 'deadline', 'now', 'previous', 'closed', 'error'];
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`retirement timing: ${message}`);
}
export function parseRetirementFrame(line: string): RetirementFrame {
  const tokens = line.replace(/\r$/, '').split(' '), v: Record<string, string> = {};
  requireValue(tokens.shift() === 'retirement-timing' && tokens.length === fields.length, 'frame size');
  for (const [i, token] of tokens.entries()) {
    const split = token.indexOf('='); requireValue(split > 0 && token.slice(0, split) === fields[i], 'fields/order');
    v[fields[i]!] = token.slice(split + 1);
  }
  const n = (key: string) => {
    requireValue(/^\d+$/.test(v[key]!), `integer ${key}`);
    const value = Number(v[key]); requireValue(Number.isSafeInteger(value), `safe integer ${key}`); return value;
  };
  requireValue(v.mode === 'live' || v.mode === 'exited', 'mode');
  requireValue(/^[a-f0-9]{32}$/.test(v.nonce!), 'nonce');
  for (const key of ['helper-created', 'created', 'thread-created']) requireValue(/^[1-9]\d{0,19}$/.test(v[key]!), key);
  return {phase: v.phase!, mode: v.mode, nonce: v.nonce!, helper: n('helper'), helperCreated: v['helper-created']!,
    root: n('root'), created: v.created!, tid: n('tid'), threadOwner: n('thread-owner'), threadCreated: v['thread-created']!, result: n('result'),
    started: n('started'), deadline: n('deadline'), now: n('now'), previous: n('previous'), closed: n('closed'), error: n('error')};
}
/** Protocol validity never converts the original fatal absence gates to success. */
export function validateRetirementTiming(result: Captured, expected: {
  mode: RetirementMode; nonce: string; helper: {pid: number; created: string}; root: {pid: number; created: string}; marker: string;
  additionalCleanupPassed?: boolean;
  anchorMode?: 'exclusive' | 'held';
}): RetirementReport {
  const report: RetirementReport = {mode: expected.mode, protocolValid: false, prerequisites: false,
    reproducesBaseline: false, cleanupGatesPassed: false, frames: [], productionAccepted: false, causeConfirmed: false};
  try {
    requireValue(!result.timedOut && [1, 125].includes(result.code!) && result.pid === expected.helper.pid, 'captured helper completion');
    requireValue(/^[A-Za-z0-9_-]+$/.test(expected.marker), 'marker');
    report.frames = result.err.split(/\r?\n/).filter(l => l.startsWith('retirement-timing')).map(parseRetirementFrame);
    const phases = expected.mode === 'live' ? ['start', 'ready', 'suspend', 'assign', 'resume', 'release', 'exit', 'complete']
      : ['start', 'ready', 'suspend', 'resume', 'release', 'exit', 'assign', 'complete'];
    requireValue(report.frames.map(f => f.phase).join(',') === phases.join(','), 'phase order/single assignment/completion');
    const start = report.frames[0]!;
    requireValue(start.helper === expected.helper.pid && start.helperCreated === expected.helper.created && start.nonce === expected.nonce,
      'captured helper/nonce');
    requireValue(start.root === expected.root.pid && start.created === expected.root.created && start.root > 0 && start.root !== start.helper && start.tid > 0 && start.threadOwner === start.root && start.deadline === start.started + 15000, 'root/thread/start deadline');
    let now = start.started;
    for (const f of report.frames) {
      requireValue(f.mode === expected.mode && f.nonce === start.nonce && f.helper === start.helper && f.helperCreated === start.helperCreated &&
        f.root === start.root && f.created === start.created && f.tid === start.tid && f.threadOwner === start.threadOwner && f.threadCreated === start.threadCreated, 'identity/owner changed');
      requireValue(f.result === 1 && f.error === 0 && f.started === start.started && f.deadline === start.deadline && f.now >= now, 'result/error/time changed');
      requireValue(f.phase === 'complete' || f.now < start.deadline, 'absolute target deadline'); now = f.now;
      requireValue(f.previous === (f.phase === 'resume' ? 1 : 0) && f.closed === (f.phase === 'start' ? 0 : 1), 'suspend/resume count/anchor closure');
    }
    const root = result.out.match(new RegExp(`^inspect-start=${expected.marker}\\.generation-0 pid=(\\d+)\\r?$`, 'm'))?.[1];
    requireValue(root === String(start.root), 'root inspector identity');
    for (let depth = 0; depth < 3; depth++) {
      const label = `${expected.marker}.generation-${depth}`;
      const pid = result.out.match(new RegExp(`^inspect-start=${label.replaceAll('.', '\\.')} pid=(\\d+)\\r?$`, 'm'))?.[1];
      requireValue(pid && result.out.includes(`${label} appcontainer=1 in-job=1 routing=${depth === 0 ? 1 : 0}`) &&
        result.out.includes(`${label} ambient-denial=5`) && result.out.includes(`${label} host-debug-control=0 known=1`) &&
        result.out.includes(`${label} inspect-exit=1 child-exit=${depth === 2 ? 0 : 1} forced=0`), 'original routing/result/normal descendants');
      if (depth < 2) {
        const child = result.out.match(new RegExp(`^inspect-start=${expected.marker}\\.generation-${depth + 1} pid=(\\d+)\\r?$`, 'm'))?.[1];
        requireValue(child && new RegExp(`^retirement-child-closed pid=${pid} depth=${depth} child=${child} thread=1 process=1\\r?$`, 'm').test(result.err),
          'exact child references closed before READY');
      }
    }
    requireValue(result.err.split(/\r?\n/).filter(l => l.startsWith('private-map pid=')).join() === `private-map pid=${root} set=0x00000000`, 'one initial root map');
    requireValue(result.err.split(/\r?\n/).filter(l => l.startsWith('debug-create ')).every(l =>
      l === `debug-create pid=${root} job=1 nonbreakaway=1 package/capability=1 lpac=1 attribute=0x00000000`) &&
      result.err.split(/\r?\n/).filter(l => l.startsWith('debug-create ')).length === 2, 'live root confinement');
    for (const [role, count] of [['launch', 1], ['boundary', 2]] as const) {
      const lines = result.err.split(/\r?\n/).filter(l => l.startsWith(`token-cleanup role=${role} `));
      requireValue(lines.length === count && lines.every(l => l === `token-cleanup role=${role} pid=${root} success=1 error=0`), 'token closure');
    }
    requireValue(!/map-swap |target-creator-|setter-assignment|creator-ready|debug-event /.test(result.err), 'matched settings');
    const names = [...result.err.matchAll(/^private-map path=(\S+) create=0x00000000\r?$/gm)];
    const replacements = [...result.err.matchAll(/^map-retire named path=(\S+) create=0x00000000\r?$/gm)];
    const path = names[0]?.[1];
    requireValue(names.length === 1 && path?.replace(/^\\Sessions\\\d+(?=\\BaseNamedObjects\\)/, '') === String.raw`\BaseNamedObjects\boite.route.${result.pid}` &&
      replacements.length === 1 && replacements[0]![1] === `${path}.retired`, 'owned names/single creation');
    const assignments = result.err.split(/\r?\n/).filter(l => /^map-retire (?:live )?pid=/.test(l));
    requireValue(assignments.length === 1 && assignments[0] === (expected.mode === 'live'
      ? `map-retire live pid=${root} set=0x00000000 named=1 inherited=0 links=0` : `map-retire pid=${root} set=0x00000000`), 'one replacement in selected state');
    if (expected.mode === 'live') requireValue(!result.err.includes('map-retire ready '), 'no second exited retirement');
    else requireValue(result.err.includes(`map-retire ready pid=${root} signaled=1 job-active=0 exit=1`), 'exited-only preconditions');
    const position = (prefix: string) => {
      const lines = result.err.split(/\r?\n/).filter(l => l.startsWith(prefix));
      requireValue(lines.length === 1, `unique native event ${prefix}`); return result.err.indexOf(lines[0]!);
    };
    const ordered = (prefixes: string[]) => {
      let previous = -1;
      for (const prefix of prefixes) {const next = position(prefix); requireValue(next > previous, 'native operation/lifetime ordering'); previous = next;}
    };
    const phase = (name: string) => `retirement-timing phase=${name} `;
    const nativeAssignment = expected.mode === 'live' ? `map-retire live pid=${root} ` : `map-retire pid=${root} `;
    ordered(expected.mode === 'live'
      ? [phase('ready'), phase('suspend'), 'map-retire named path=',
        ...(expected.anchorMode === 'exclusive' ? ['cleanup close=retire-named-map ', nativeAssignment] : [nativeAssignment, 'cleanup close=retire-named-map ']),
        phase('assign'), phase('resume'), phase('release'), phase('exit')]
      : [phase('release'), phase('exit'), 'cleanup job-active=0', `map-retire ready pid=${root} `,
        'map-retire named path=', nativeAssignment, 'cleanup close=retire-named-map ', phase('assign')]);
    for (let depth = 0; depth < 2; depth++) {
      const pid = result.out.match(new RegExp(`^inspect-start=${expected.marker}\\.generation-${depth} pid=(\\d+)\\r?$`, 'm'))?.[1];
      requireValue(position(`retirement-child-closed pid=${pid} depth=${depth} `) < position(phase('ready')), 'child references closed before controller READY');
    }
    ordered(['cleanup retired-open phase=immediate ', 'cleanup retired-open phase=checkpoint ', 'caller snapshot=after ',
      'cleanup retired-open phase=final ', phase('complete')]);
    for (const prefix of ['cleanup map-open=', 'cleanup map-eventual-open=', 'cleanup checkpoint-map-open=',
      ...['root-thread', 'root-process', 'job', 'link', 'map'].map(object => `cleanup close=${object} `),
      ...['station-restore', 'desktop', 'station'].map(action => `window-cleanup action=${action} `),
      ...[0, 1, 2].map(index => `stream-cleanup index=${index} `)])
      requireValue(position(prefix) < position(phase('complete')), 'completion before original cleanup gates');
    for (const object of ['retire-named-map', 'root-thread', 'root-process', 'job', 'link', 'map'])
      requireValue(result.err.includes(`cleanup close=${object} closed=1 error=0`), `owned ${object} closure`);
    for (const action of ['station-restore', 'desktop', 'station']) requireValue(result.err.includes(`window-cleanup action=${action} success=1 error=0`), 'window cleanup');
    for (let i = 0; i < 3; i++) requireValue(result.err.includes(`stream-cleanup index=${i} success=1 error=0`), 'streams');
    const before = result.err.match(/^caller snapshot=before (.+)\r?$/m)?.[1]?.replace(/\r$/, '');
    requireValue(before && before === result.err.match(/^caller snapshot=after (.+)\r?$/m)?.[1]?.replace(/\r$/, '') &&
      result.err.includes('cleanup job-active=0'), 'caller/private job cleanup');
    const observations = ['immediate', 'checkpoint', 'final'].map(phase => {
      const matches = [...result.err.matchAll(new RegExp(`^cleanup retired-open phase=${phase} status=(0x[0-9a-f]{8}) absent=([01]) closed=1 error=0 path=(\\S+)\\r?$`, 'gm'))];
      requireValue(matches.length === 1, 'replacement gates complete'); const row = matches[0]!;
      requireValue(row[3] === `${path}.retired` && (row[1] === '0xc0000034' ? row[2] === '1' : row[1] === '0x00000000' && row[2] === '0'), 'gate status/name');
      return row[2] === '1';
    });
    const originalGates = [
      /^cleanup map-open=(0x[0-9a-f]{8}) absent=([01])\r?$/m,
      /^cleanup map-eventual-open=(0x[0-9a-f]{8}) absent=([01]) elapsed-ms=\d+ attempts=\d+ limit-ms=2000\r?$/m,
      /^cleanup checkpoint-map-open=(0x[0-9a-f]{8}) absent=([01]) closed=1 error=0 wall-ms=\d+/m,
    ].map(pattern => {
      const row = result.err.match(pattern); requireValue(row && (row[1] === '0xc0000034' ? row[2] === '1' :
        row[1] === '0x00000000' && row[2] === '0'), 'original map gate completion/status');
      return row[2] === '1';
    });
    requireValue(result.err.indexOf('retirement-timing phase=complete ') > result.err.indexOf('cleanup retired-open phase=final '), 'completion after all cleanup');
    report.prerequisites = true; report.protocolValid = true; report.reproducesBaseline = originalGates.every(Boolean) && observations.every(v => !v);
    report.cleanupGatesPassed = originalGates.every(Boolean) && observations.every(Boolean) && expected.additionalCleanupPassed !== false;
    report.outcome = !originalGates.every(Boolean) ? 'original-map-retained' : observations.every(Boolean) ? 'absent-with-helper-alive' : 'retained-during-helper-life';
    requireValue(result.code === (report.cleanupGatesPassed ? 1 : 125), 'fatal gate result preserved');
  } catch (error) {report.protocolValid = false; report.error = String(error);}
  return report;
}
