import type {Captured} from './capture.ts';
import {validateRetirementTiming, type RetirementReport} from './retirement-timing.ts';

export interface TwinEvent {
  phase: string; role: 'attached' | 'unused'; nonce: string; helper: number; helperCreated: string;
  root: number; created: string; path: string; now: number; status: string; closed: number;
  verified: number; granted: string; attributes: string; flags: number; absent: number; error: number;
}
export interface DirectoryTwinReport {
  protocolValid: boolean; prerequisites: boolean; reproducesBaseline: boolean; cleanupGatesPassed: boolean;
  unusedAbsencePassed: boolean; events: TwinEvent[]; timing?: RetirementReport; error?: string;
  outcome?: string; causeConfirmed: false; productionAccepted: false;
  postHelper?: {kind: string; path: string; absent: boolean; code: number | null; timedOut: boolean}[];
  postHelperAbsencePassed?: boolean;
}
const fields = ['phase', 'role', 'nonce', 'helper', 'helper-created', 'root', 'created', 'path', 'now',
  'status', 'closed', 'verified', 'granted', 'attributes', 'flags', 'absent', 'error'];
function requireValue(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(`directory twin: ${detail}`);
}
function parse(line: string): TwinEvent {
  const tokens = line.split(' '), values: Record<string, string> = {};
  requireValue(tokens.shift() === 'directory-twin' && tokens.length === fields.length, 'record size');
  for (const [i, token] of tokens.entries()) {
    const split = token.indexOf('='); requireValue(split > 0 && token.slice(0, split) === fields[i], 'field order');
    values[fields[i]!] = token.slice(split + 1);
  }
  const number = (key: string) => {
    requireValue(/^\d+$/.test(values[key]!), key);
    const result = Number(values[key]); requireValue(Number.isSafeInteger(result), key); return result;
  };
  requireValue(values.role === 'attached' || values.role === 'unused', 'role');
  requireValue(/^[a-f0-9]{32}$/.test(values.nonce!), 'nonce');
  for (const field of ['helper-created', 'created']) requireValue(/^[1-9]\d{0,19}$/.test(values[field]!), field);
  for (const field of ['status', 'granted', 'attributes']) requireValue(/^0x[0-9a-f]{8}$/.test(values[field]!), field);
  return {phase: values.phase!, role: values.role, nonce: values.nonce!, helper: number('helper'), helperCreated: values['helper-created']!,
    root: number('root'), created: values.created!, path: values.path!, now: number('now'), status: values.status!,
    closed: number('closed'), verified: number('verified'), granted: values.granted!, attributes: values.attributes!, flags: number('flags'), absent: number('absent'), error: number('error')};
}

/** An unattached twin adds fatal cleanup evidence; no old gate is replaced. */
export function validateDirectoryTwin(result: Captured, expected: Parameters<typeof validateRetirementTiming>[1]): DirectoryTwinReport {
  const report: DirectoryTwinReport = {protocolValid: false, prerequisites: false, reproducesBaseline: false,
    cleanupGatesPassed: false, unusedAbsencePassed: false, events: [], causeConfirmed: false, productionAccepted: false};
  try {
    requireValue(expected.mode === 'live', 'LIVE barrier required');
    const lines = result.err.split(/\r?\n/);
    report.events = lines.filter(line => line.startsWith('directory-twin')).map(parse);
    const names = lines.filter(line => line.startsWith('private-map path='));
    requireValue(names.length === 1, 'single original name');
    const path = names[0]!.match(/^private-map path=(\S+) create=0x00000000$/)?.[1];
    requireValue(path, 'successfully created original');
    const phases = ['create:attached', 'verify-create:attached', 'create:unused', 'verify-create:unused',
      'open:attached', 'verify-open:attached', 'same:attached', 'open:unused', 'verify-open:unused', 'same:unused',
      'close-open:attached', 'close-open:unused',
      ...(expected.anchorMode ? ['close-create:unused', ...(expected.anchorMode === 'exclusive' ? ['close-create:attached', 'set:attached'] : ['set:attached', 'close-create:attached'])]
        : ['set:attached', 'close-create:attached', 'close-create:unused']),
      'immediate:unused', 'checkpoint:unused', 'final:unused'];
    requireValue(report.events.map(e => `${e.phase}:${e.role}`).join() === phases.join(), 'exact actual operation sequence; unused never assigned');
    const observations = report.events.filter(e => ['immediate', 'checkpoint', 'final'].includes(e.phase));
    let previous = 0;
    for (const e of report.events) {
      requireValue(e.nonce === expected.nonce && e.helper === expected.helper.pid && e.helperCreated === expected.helper.created &&
        e.root === expected.root.pid && e.created === expected.root.created, 'captured identity/nonce');
      requireValue(e.path === `${path}.${e.role === 'attached' ? 'retired' : 'unused'}`, 'exact owned sibling');
      requireValue(e.now >= previous && e.error === 0 && e.flags === 0 && e.attributes === '0x00000000', 'time/attributes/inheritance'); previous = e.now;
      const observe = observations.includes(e), verify = e.phase.startsWith('verify-'), close = e.phase.startsWith('close-') || observe;
      requireValue(e.closed === +close && e.verified === +verify && e.granted === (verify ? '0x000f000f' : '0x00000000'), 'known closure/name/type/rights verification');
      requireValue(observe ? ((e.status === '0xc0000034' && e.absent === 1) || (e.status === '0x00000000' && e.absent === 0))
        : e.status === '0x00000000' && e.absent === 0, 'operation/observation result');
    }
    report.unusedAbsencePassed = observations.every(e => e.absent === 1);
    const timing = validateRetirementTiming(result, {...expected, additionalCleanupPassed: report.unusedAbsencePassed});
    report.timing = timing; requireValue(timing.protocolValid && timing.prerequisites, `barrier/original gates: ${timing.error}`);
    const position = (prefix: string) => {
      const found = lines.map((line, i) => line.startsWith(prefix) ? i : -1).filter(i => i >= 0);
      requireValue(found.length === 1, `single native operation ${prefix}`); return found[0]!;
    };
    const event = (phase: string, role: string) => `directory-twin phase=${phase} role=${role} `;
    const order = ['retirement-timing phase=suspend ', event('create', 'attached'), 'map-retire named path=',
      event('verify-create', 'attached'), event('create', 'unused'), event('verify-create', 'unused'),
      event('open', 'attached'), event('verify-open', 'attached'), event('same', 'attached'),
      event('open', 'unused'), event('verify-open', 'unused'), event('same', 'unused'),
      'cleanup close=twin-attached-open ', event('close-open', 'attached'), 'cleanup close=twin-unused-open ', event('close-open', 'unused'),
      ...(expected.anchorMode ? [
        'cleanup close=twin-unused-map ', event('close-create', 'unused'),
        ...(expected.anchorMode === 'exclusive' ? ['cleanup close=retire-named-map ', event('close-create', 'attached')] : []),
        event('set', 'attached'), `map-retire live pid=${expected.root.pid} `,
        ...(expected.anchorMode === 'held' ? ['cleanup close=retire-named-map ', event('close-create', 'attached')] : []),
      ] : [event('set', 'attached'), `map-retire live pid=${expected.root.pid} `,
        'cleanup close=retire-named-map ', event('close-create', 'attached'), 'cleanup close=twin-unused-map ', event('close-create', 'unused')]),
      'retirement-timing phase=assign ', 'retirement-timing phase=resume ', 'retirement-timing phase=release ', 'retirement-timing phase=exit '];
    const indexes = order.map(position); requireValue(indexes.every((index, i) => !i || index > indexes[i - 1]!), 'native operation/barrier order');
    const suspend = timing.frames.find(f => f.phase === 'suspend')!, assign = timing.frames.find(f => f.phase === 'assign')!;
    const exit = timing.frames.find(f => f.phase === 'exit')!, complete = timing.frames.find(f => f.phase === 'complete')!;
    for (const e of report.events) requireValue(observations.includes(e) ? e.now >= exit.now && e.now <= complete.now
      : e.now >= suspend.now && e.now <= assign.now && e.now < suspend.deadline, 'actual operation within captured lifetime');
    for (const role of ['attached-open', 'unused-open', 'unused-map'])
      requireValue(lines.includes(`cleanup close=twin-${role} closed=1 error=0`), `native anchor close ${role}`);
    for (const phase of ['immediate', 'checkpoint', 'final']) {
      const index = position(event(phase, 'unused'));
      requireValue(index < position(`cleanup retired-open phase=${phase} `) && index < position('retirement-timing phase=complete '), 'matched observation/completion order');
      const prerequisite = phase === 'immediate' ? 'cleanup close=map ' : phase === 'checkpoint' ? 'cleanup checkpoint-map-open=' : 'caller snapshot=after ';
      requireValue(index > position(prerequisite), 'observation after original cleanup phase');
    }
    report.prerequisites = true; report.protocolValid = true; report.reproducesBaseline = timing.reproducesBaseline;
    report.cleanupGatesPassed = timing.cleanupGatesPassed;
    report.outcome = !report.unusedAbsencePassed ? 'unused-retained' : timing.reproducesBaseline ? 'attachment-associated-retention'
      : timing.cleanupGatesPassed ? 'both-absent' : timing.outcome;
  } catch (error) {report.protocolValid = false; report.error = String(error);}
  return report;
}
