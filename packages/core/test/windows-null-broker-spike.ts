/** Opt-in falsifier only. No production admission or helper changes. */
import {createHash, randomUUID} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {release, tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {Bus} from '../src/bus.ts';
import {Journal} from '../src/journal.ts';
import {ProcRegistry} from '../src/procs.ts';
import {ExecutionProtections} from '../src/execution-protection.ts';
import {assertExecutionPolicy} from '../src/execution-policy.ts';
import {selectedEnvironment} from '../../../tests/diagnostics/windows-debug-map/environment.ts';

const diagnostics = join(import.meta.dir, '../../../tests/diagnostics/windows-null-broker');
const production = join(import.meta.dir, '../src/platform/windows/protected-tool.c');
export const productionHash = '8f414f91eab4ed1e9a846ae3d0bac64eec11e5d924a2a811f998f91567b25f5a';
const ntdllHash = '160ef9b82e2895ef48fa031cb1cf683a8b123febf7cf7d5590cd3104864424b3';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface BrokerVerdict {kind: 'positive' | 'negative' | 'incomplete' | 'setup' | 'unsupported' | 'timeout'; experimentComplete: boolean; productionAccepted: false}
type Row = Record<string, string>;
const verdict = (kind: BrokerVerdict['kind']): BrokerVerdict => ({kind, experimentComplete: kind === 'positive' || kind === 'negative', productionAccepted: false});
const decimal = (value?: string) => !!value && /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value));
const hex = (value?: string) => !!value && /^0x[0-9a-f]{8}$/.test(value);
const negativeStatus = (value?: string) => hex(value) && Number.parseInt(value!, 16) >= 0x80000000;
const known = new Set(['BIND','IMAGE','PROCESS_IMAGE','PRIMITIVE','END','FAILURE','POINTER','EVENT','HANDLE','SUSPEND','RESUME','DEFER',
  'DELEGATE','EXCEPTION','EXIT','OPEN','MODE','OBJECT','CHECK','DENY','OFF','READY','DETACHED','BUN','ROLLBACK','MEASUREMENT','TRANSFER']);
function parse(text: string): Row[] | null {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('NB_')) continue;
    const [tag, ...fields] = line.split(' '), entries = fields.map(field => field.split('='));
    if (!known.has(tag!.slice(3)) || entries.some(e => e.length !== 2 || !e[0] || !e[1] || e[0] === 'tag') || new Set(entries.map(e => e[0])).size !== entries.length) return null;
    rows.push({tag: tag!.slice(3), ...Object.fromEntries(entries)});
  }
  return rows;
}
const unique = (rows: Row[], key: (r: Row) => string) => new Set(rows.map(key)).size === rows.length;
function completeTrace(rows: Row[], bindings: Row[]): boolean {
  const records = (tag: string) => rows.filter(r => r.tag === tag);
  const events = records('EVENT'), images = records('PROCESS_IMAGE'), exits = records('EXIT');
  const bound = new Set(bindings.map(r => r.pid));
  if (!events.length || events[0]!.pid !== bindings.find(r => r.generation === 'root')!.pid ||
      images.length !== bound.size || !unique(images, r => r.pid!) || images.some(r => !bound.has(r.pid) || !/^[0-9a-f]{64}$/.test(r.sha ?? '')) ||
      exits.length !== bound.size || !unique(exits, r => r.pid!) || exits.some(r => !bound.has(r.pid) || !hex(r.code))) return false;
  const processes = new Map<string, Set<string>>(), live = new Set<string>(), handles = new Set<string>();
  const created = new Set<string>(), loaded = new Set<string>(), startup = new Set<string>();
  const held = new Map<string, {owner: string; previous: number; deferred: boolean}>();
  const owners = new Map<string, string>();
  let eventNumber = 0;
  for (const row of rows) {
    const pid = row.pid!, tid = row.tid!, threads = processes.get(pid);
    if (['SUSPEND','RESUME','DEFER'].includes(row.tag!)) {
      if (!live.has(pid) || !threads?.has(tid) || !threads.has(row.owner!) || tid === row.owner) return false;
      const key = `${pid}:${tid}`, previous = held.get(key);
      if (row.tag === 'SUSPEND') {
        if (previous || !decimal(row.previous) || Number(row.previous) >= 0xffffffff || (owners.has(pid) && owners.get(pid) !== row.owner)) return false;
        owners.set(pid, row.owner!); held.set(key, {owner: row.owner!, previous: Number(row.previous), deferred: false});
      } else if (row.tag === 'DEFER') {
        if (!previous || previous.owner !== row.owner || previous.deferred) return false;
        previous.deferred = true;
      } else {
        if (!previous || previous.owner !== row.owner || !decimal(row.previous) || Number(row.previous) !== previous.previous + 1) return false;
        held.delete(key);
        if (![...held.keys()].some(k => k.startsWith(`${pid}:`))) owners.delete(pid);
      }
      continue;
    }
    if (row.tag !== 'EVENT') continue;
    if (row.number !== String(++eventNumber) || !bound.has(pid) || !decimal(tid) || tid === '0') return false;
    const code = row.code;
    if (code === '3') {
      if (created.has(pid)) return false;
      const binding = bindings.find(b => b.pid === pid)!;
      if (binding.generation !== 'root' && !live.has(binding.parent!)) return false;
      created.add(pid); live.add(pid); processes.set(pid, new Set([tid]));
      handles.add(`${pid}:process:0`); handles.add(`${pid}:thread:${tid}`);
      continue;
    }
    if (!live.has(pid) || !threads) return false;
    if (code === '2') {
      const key = `${pid}:thread:${tid}`;
      if (handles.has(key)) return false;
      threads.add(tid); handles.add(key);
    } else {
      if (!threads.has(tid)) return false;
      if (code === '4') {
        if (held.has(`${pid}:${tid}`) || owners.get(pid) === tid) return false;
        threads.delete(tid);
      } else if (code === '5') {
        if (owners.has(pid)) return false;
        live.delete(pid);
      } else if (code === '6') loaded.add(pid);
      else if (code === '1') startup.add(pid);
      else if (code !== '7' && code !== '8') return false;
    }
  }
  if (held.size || owners.size) return false;
  if (live.size || created.size !== bound.size || loaded.size !== bound.size || startup.size !== bound.size) return false;
  const ownership = new Map<string, string>();
  for (const row of records('HANDLE')) {
    const key = `${row.pid}:${row.kind}:${row.tid}`;
    if (!handles.has(key)) return false;
    if (row.action === 'own' && !ownership.has(key)) ownership.set(key, 'own');
    else if (row.action === 'close' && ownership.get(key) === 'own') ownership.set(key, 'close');
    else return false;
  }
  return ownership.size === handles.size && [...ownership.values()].every(action => action === 'close');
}
function fullNativeProof(rows: Row[], pid: string): boolean {
  const records = (tag: string) => rows.filter(r => r.tag === tag);
  const opens = records('OPEN').filter(r => r.pid === pid), modes = records('MODE').filter(r => r.pid === pid), objects = records('OBJECT').filter(r => r.pid === pid);
  if (opens.length !== 9 || !unique(opens, r => `${r.api}:${r.access}`) || opens.some(r => !['0','1','2'].includes(r.api!) || !['0','1','2'].includes(r.access!) ||
      r.async !== '0' || r.disposition !== '1' || r.status !== '0x00000000' || r.type !== '2' || r.device !== '21' || r.ok !== '1' ||
      r.eof !== (r.access === '1' ? '0' : '2') || r.written !== (r.access === '0' ? '0' : '8192') || !hex(r.granted) || !hex(r.mode) || !(Number.parseInt(r.mode!,16) & 0x20) ||
      r.granted !== (r.access === '1' && r.api === '0' ? '0x00120196' : ['0x00120089','0x00120116','0x0012019f'][Number(r.access)]))) return false;
  if (modes.length !== 2 || !unique(modes, r => r.async!) || modes.some(r => !['0','1'].includes(r.async!) || r.status !== '0x00000000' || r.ok !== '1' || !hex(r.mode) || !hex(r.granted) || !!(Number.parseInt(r.mode!,16) & 0x20) !== (r.async === '0')) ||
      objects.length !== 1 || objects[0]!.same !== '0x00000000' || objects[0]!.different !== '0xc00001ac' || objects[0]!.ok !== '1') return false;
  const denied = records('DENY').filter(r => r.pid === pid);
  const expected = ['ambient','excluded','hostfile','credential','hostprocess','direct','acl','forged-path','breakaway','network'];
  if (denied.length !== expected.length || expected.some(name => denied.filter(r => r.name === name && r.denied === '1').length !== 1)) return false;
  const errors: Record<string, string> = {ambient:'5',excluded:'5',hostfile:'5',credential:'6',hostprocess:'5',direct:String(0xc0000022),acl:String(0xc00000bb),'forged-path':String(0xc0000022),breakaway:'5'};
  if (denied.some(r => !decimal(r.error) || r.error === '0' || (errors[r.name!] && r.error !== errors[r.name!]))) return false;
  for (const name of ['redirection','two-threads','control-handles']) if (records('CHECK').filter(r => r.pid === pid && r.name === name && r.ok === '1').length !== 1) return false;

  return records('DELEGATE').filter(r => r.pid === pid && r.opened === '1' && r.status === '0x00000000').length >= 28;
}
function completeTraffic(rows: Row[]): boolean {
  const delegates = rows.filter(r => r.tag === 'DELEGATE'), measurements = rows.filter(r => r.tag === 'MEASUREMENT');
  const bound = new Set(rows.filter(r => r.tag === 'BIND').map(r => r.pid));
  const end = rows.find(r => r.tag === 'END');
  if (!decimal(end?.delegations) || Number(end!.delegations) !== delegates.length ||
      measurements.length !== delegates.filter(r => r.opened === '1').length || !unique(measurements,r => r.sequence!)) return false;
  const measured = new Set<string>();
  for (const [index,row] of delegates.entries()) {
    if (!bound.has(row.pid) || row.sequence !== String(index + 1) || !['open','create'].includes(row.api!) || !hex(row.requested) || !hex(row.options) ||
        !decimal(row.disposition) || Number(row.disposition) > 5 || !hex(row.status) || !['0','1'].includes(row.opened!) || !['0','1'].includes(row.valid!) ||
        row.hostClosed !== '1' || row.remoteClosed !== '1') return false;
    const measurement = measurements.find(r => r.sequence === row.sequence);
    if (row.opened === '0') {if (!negativeStatus(row.status) || measurement) return false; continue;}
    const rollback = row.status === '0xc0000005' && rows.some(r => r.tag === 'TRANSFER' && r.pid === row.pid && r.injected === '1' && r.remoteClosed === '1' && r.hostClosed === '1');
    if ((row.status !== '0x00000000' && !rollback) || row.valid !== '1' || row.type !== '2' || row.device !== '21' || !hex(row.granted) || !hex(row.mode) ||
        !measurement || measurement.pid !== row.pid || measurement.ok !== '1' || measurement.same !== '0x00000000' || measurement.different !== '0xc00001ac' ||
        measurement.previous !== String(Number(measured.has(row.pid!))) || rows.indexOf(measurement) > rows.indexOf(row)) return false;
    measured.add(row.pid!);
  }
  return true;
}
export function classifyBroker(text: string, scenario: string, timedOut = false, expectedImages?: {root: string; native: string}): BrokerVerdict {
  if (timedOut) return verdict('timeout');
  const rows = parse(text); if (!rows) return verdict('incomplete');
  const records = (tag: string) => rows.filter(r => r.tag === tag);
  const failures = records('FAILURE');
  if (failures.length) {
    const kind = failures[0]!.kind;
    return verdict(failures.length === 1 && ['timeout','unsupported','setup'].includes(kind!) ? kind as BrokerVerdict['kind'] : 'incomplete');
  }
  const ends = records('END'), bindings = records('BIND'), images = records('IMAGE');
  if (ends.length !== 1 || !['error','active','owned','suspended','pending'].every(k => ends[0]![k] === '0') || !bindings.length ||
      !unique(bindings, r => r.pid!) || bindings.filter(r => r.generation === 'root').length !== 1 || images.length !== bindings.length || !unique(images, r => r.pid!)) return verdict('incomplete');
  const root = bindings.find(r => r.generation === 'root')!;
  if (bindings.some(r => !decimal(r.pid) || r.pid === '0' || !decimal(r.parent) || r.parent === '0' || r.pid === r.parent ||
      !/^S-1-15-2-\d+(?:-\d+)*$/.test(r.package ?? '') || r.package !== root.package ||
      !['lpac','registry','job','dup','capabilities'].every(k => r[k] === '1') ||
      (r !== root && (r.generation !== 'child' || !bindings.some(parent => parent.pid === r.parent)))) ||
      images.some(r => !bindings.some(b => b.pid === r.pid) || r.sha !== ntdllHash || r.exports !== '1' || r.startup !== '1')) return verdict('incomplete');
  if (!completeTrace(rows, bindings) || !completeTraffic(rows)) return verdict('incomplete');
  const processImages = records('PROCESS_IMAGE');
  if (expectedImages && (processImages.find(r => r.pid === root.pid)?.sha !== expectedImages.root ||
      processImages.some(r => r.sha !== expectedImages.root && r.sha !== expectedImages.native))) return verdict('incomplete');
  if (!['primitive','unhandled','root-exit'].includes(scenario) && records('EXIT').some(r => r.code !== '0x00000000')) return verdict('incomplete');
  const bound = (r: Row) => !!bindings.find(b => b.pid === r.pid);
  const primitives = records('PRIMITIVE');
  if (scenario === 'primitive') return primitives.length === 1 && bound(primitives[0]!) && primitives[0]!.status === '0xc0000022' &&
    records('DELEGATE').some(r => r.pid === primitives[0]!.pid && r.status === primitives[0]!.status && r.opened === '0' && r.valid === '1') &&
    ['opened'].every(k => primitives[0]![k] === '0') && ['hostClosed','remoteClosed'].every(k => primitives[0]![k] === '1') ? verdict('negative') : verdict('incomplete');
  if (primitives.length) return verdict('incomplete');
  if (scenario === 'pointers') {
    const pointers = records('POINTER');
    if (records('DELEGATE').filter(r=>r.status==='0xc0000005'&&r.opened==='0').length < 3 || !records('DELEGATE').some(r=>r.status==='0x00000000'&&r.opened==='1') || pointers.length !== 7 || !unique(pointers, r => `${r.transport}:${r.name}`) || pointers.some(r => !bound(r) || r.handles !== '0')) return verdict('incomplete');
    for (const name of ['readonly-handle','readonly-iosb','boundary']) {
      const off = pointers.find(r => r.name === name && r.transport === 'off'), on = pointers.find(r => r.name === name && r.transport === 'on');
      if (!off || !on || !negativeStatus(off.status) || off.status !== on.status || [off,on].some(r => r.unchanged !== '1' || r.opened !== '0')) return verdict('incomplete');
    }
    const valid = pointers.find(r => r.name === 'writable' && r.transport === 'on');
    return valid?.status === '0x00000000' && valid.opened === '1' && valid.unchanged === '0' ? verdict('positive') : verdict('incomplete');
  }
  if (scenario === 'off') {
    const off = records('OFF'), ambient=records('DENY').filter(r=>r.name==='ambient'); return off.length === 1 && bound(off[0]!) && off[0]!.status === '0xc0000022' && off[0]!.opened === '0' &&
      ambient.length===1&&ambient[0]!.pid===off[0]!.pid&&ambient[0]!.denied==='1'&&ambient[0]!.error==='5' ? verdict('positive') : verdict('incomplete');
  }
  if (scenario === 'handled' || scenario === 'unhandled') {
    const expected = scenario === 'handled' ? '0xe0424242' : '0xe0434343', exceptions = records('EXCEPTION').filter(r => r.code === expected), exits = records('EXIT');
    if (!exceptions.length || exceptions.some(r => !bound(r) || r.forwarded !== '1') || exits.length !== 1 || !bound(exits[0]!)) return verdict('incomplete');
    return scenario === 'handled' ? records('CHECK').filter(r => r.name === 'handled' && r.ok === '1').length === 1 && exits[0]!.code === '0x00000000' ? verdict('positive') : verdict('incomplete') :
      exceptions.some(r => r.first === '0') && exits[0]!.code === expected ? verdict('positive') : verdict('incomplete');
  }
  if (scenario === 'rollback') {
    const rollback = records('ROLLBACK'), transfer = records('TRANSFER'); return rollback.length === 1 && bound(rollback[0]!) && rollback[0]!.remoteClosed === '1' && rollback[0]!.unchanged === '1' && rollback[0]!.handles === '0' &&
      transfer.length === 1 && transfer[0]!.pid === rollback[0]!.pid && transfer[0]!.remoteClosed === '1' && transfer[0]!.hostClosed === '1' && transfer[0]!.injected === '1' ? verdict('positive') : verdict('incomplete');
  }
  if (scenario === 'native' || scenario === 'root-exit') {
    const child = bindings.find(r => r.generation === 'child' && r.parent === root.pid);
    if (bindings.length !== 2 || !child || processImages.some(r => r.sha !== processImages.find(i => i.pid === root.pid)!.sha)) return verdict('incomplete');
    for (const generation of scenario === 'native' ? bindings : [root]) if (!fullNativeProof(rows,generation.pid!)) return verdict('incomplete');
    if (records('CHECK').filter(r => r.pid === root.pid && r.name === 'ordinary-child' && r.ok === '1').length !== 1 ||
        records('EXIT').find(r => r.pid === root.pid)?.code !== '0x00000000') return verdict('incomplete');
    if (scenario === 'root-exit' && (records('READY').filter(r => r.pid === child.pid && r.wait === '1').length !== 1 ||
        records('DETACHED').filter(r => r.pid === child.pid).length !== 1 || records('EXIT').find(r => r.pid === child.pid)?.code !== '0x0000007d')) return verdict('incomplete');
    return verdict('positive');
  }
  if (scenario === 'bun') {
    const bun = records('BUN'), children = bindings.filter(r => r !== root), native = processImages.filter(r => r.sha === expectedImages?.native);
    if (!expectedImages || expectedImages.root === expectedImages.native || bindings.length !== 4 || children.some(r => r.parent !== root.pid) || native.length !== 1 ||
        !children.some(r => r.pid === native[0]!.pid) || bun.length !== 1 || bun[0]!.pid !== root.pid || !['ignore','pipe','argv','denials','network'].every(k => bun[0]![k] === '1') ||
        !fullNativeProof(rows,native[0]!.pid!) || !records('DELEGATE').some(r => r.pid === root.pid && r.opened === '1' && r.status === '0x00000000')) return verdict('incomplete');
    return verdict('positive');
  }
  return verdict('incomplete');
}
export function combineVerdicts(rows: BrokerVerdict[]): boolean {
  return rows.length === 2 && rows.every(r => r.experimentComplete && !r.productionAccepted) && rows[0]!.kind === rows[1]!.kind;
}
function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`broker provenance substitution must match once: ${before}`);
  return source.replace(before, after);
}
export function brokerSource(original: string): string {
  if (hash(original) !== productionHash) throw new Error('broker provenance: production helper changed');
  let source = once(original, '#include <windows.h>', '#include <winsock2.h>\n#include <windows.h>');
  source = once(source, 'static int launch(int count, wchar_t **args) {', '#include "debugger.h"\n#include "fixture.h"\nstatic int launch(int count, wchar_t **args) {');
  source = once(source, 'CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,', 'DEBUG_PROCESS | CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,');
  source = once(source,
    '  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &exit_code)) {error = GetLastError(); goto end;}',
    '  stage = L"launch.null-broker";\n  error = nb_debug_loop(job, &child, app, registry_read.Sid, &exit_code);\n  if (error) goto end;');
  return once(source, '  else if (count == 2 && !wcscmp(args[1], L"--diagnose-null"))',
    '  else if (count > 1 && !wcscmp(args[1], L"--broker-fixture")) result = nb_fixture(count, args);\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"run-broker")) {nb_enabled = 1; result = launch(count, args);}\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"run-off")) {nb_enabled = 0; result = launch(count, args);}\n' +
    '  else if (count > 1 && !wcscmp(args[1], L"run-rollback")) {nb_enabled = 1; nb_fault_transfer = 1; result = launch(count, args);}\n' +
    '  else if (count == 2 && !wcscmp(args[1], L"--diagnose-null"))');
}

export interface Capture {pid: number; code: number | null; out: string; err: string; timedOut: boolean; overflow: boolean}
async function boundedCapture(procs: ProcRegistry, id: string, command: string, args: string[], cwd: string, env: Record<string, string | undefined>, ms: number): Promise<Capture> {
  const child = procs.spawnPiped(id, command, args, {cwd, env, agentRoot: false}); child.proc.stdin.end();
  const result: Capture = {pid: child.record.pid, code: null, out: '', err: '', timedOut: false, overflow: false};
  const readers = [child.proc.stdout.getReader(), child.proc.stderr.getReader()]; let size = 0;
  const collect = async (index: number) => {
    const reader = readers[index]!, decoder = new TextDecoder(), field = index ? 'err' : 'out';
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 2 * 1024 * 1024) {result.overflow = true; procs.killTree(id); break;}
      result[field] += decoder.decode(next.value, {stream: true});
    }
    result[field] += decoder.decode();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = Promise.all([child.exited.then(code => {result.code = code;}), collect(0), collect(1)]);
    if (await Promise.race([finished.then(() => true), new Promise<false>(resolve => {timer = setTimeout(() => resolve(false), ms);})]) === false) {
      result.timedOut = true; procs.killTree(id);
      clearTimeout(timer);
      await Promise.race([Promise.allSettled([child.exited, ...readers.map(r => r.cancel()), procs.waitForExit(id)]), new Promise<void>(resolve => {timer = setTimeout(resolve, 6000);})]);
    }
    return result;
  } finally {clearTimeout(timer);}
}
export async function runLocalContracts(): Promise<{code: number | null; out: string; err: string}> {
  const scratch = mkdtempSync(join(tmpdir(), 'boite-null-contracts-')), journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
  try {
    const compiler = process.platform === 'win32' ? Bun.which('gcc') || Bun.which('clang') : Bun.which('cc'); if (!compiler) throw new Error('C compiler required for shared native contract harness');
    const binary = join(scratch, process.platform==='win32'?'contracts.exe':'contracts');
    const compiled = await boundedCapture(procs, 'contracts-build', compiler, ['-std=c11','-O2','-Wall','-Wextra','-Werror',join(diagnostics,'contracts.c'),'-o',binary], scratch, selectedEnvironment(), 15000);
    if (compiled.code !== 0 || compiled.timedOut) return compiled;
    return await boundedCapture(procs, 'contracts-run', binary, [], scratch, selectedEnvironment(), 5000);
  } finally {procs.killAll(); await procs.close(); journal.close(); rmSync(scratch, {recursive: true, force: true});}
}

const bunFixture = String.raw`
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dlopen, FFIType, ptr} from 'bun:ffi';
const [ambient,excluded,hostfile,credential,hostpid,url,native] = process.argv.slice(2);
const args = ['quote" and spaces','trailing\\','$(echo unsafe)'];
async function child(argv, stdio, input) {
  const p = spawn(process.execPath, argv, {stdio}); let out = '', err = '';
  p.stdout?.on('data', b => out += b); p.stderr?.on('data', b => err += b);
  const done = new Promise((resolve,reject) => {p.once('error', reject); p.once('close', (code,signal) => resolve({code,signal}));});
  if (p.stdin) p.stdin.end(input ?? '');
  const result = await done; return {...result,out,err};
}
const ignored = await child(['-e','process.exit(0)'], 'ignore');
const program = 'const input=await Bun.stdin.text(); process.stdout.write(JSON.stringify({input,args:process.argv.slice(1)}));';
const piped = await child(['-e',program,...args], ['pipe','pipe','pipe'], 'bounded input');
const pipe = piped.code === 0 && piped.out === JSON.stringify({input:'bounded input',args});
let denied = true;
for (const path of [ambient,excluded,hostfile]) {try {readFileSync(path); denied=false;} catch (e) {if(e.code!=='EACCES'&&e.code!=='EPERM') denied=false;}}
const k = dlopen('kernel32.dll', {
 OpenProcess:{args:[FFIType.u32,FFIType.i32,FFIType.u32],returns:FFIType.ptr},
 ReadFile:{args:[FFIType.ptr,FFIType.ptr,FFIType.u32,FFIType.ptr,FFIType.ptr],returns:FFIType.i32},
 CloseHandle:{args:[FFIType.ptr],returns:FFIType.i32},
 GetLastError:{args:[],returns:FFIType.u32},
});
try {
 const h=k.symbols.OpenProcess(0x50,0,Number(hostpid)); if(h){denied=false;k.symbols.CloseHandle(h);}
 const bytes=Buffer.alloc(32),used=Buffer.alloc(4);
 if(k.symbols.ReadFile(Number(credential),ptr(bytes),32,ptr(used),null)) denied=false;
} finally {k.close();}
let network = true; try {await fetch(url,{signal:AbortSignal.timeout(1500)}); network=false;} catch {}
/* Ordinary child exercises the full synthetic native denial fixture too. */
const nativeChild = spawn(native,['--broker-fixture','child','child',ambient,excluded,hostfile,credential,hostpid,new URL(url).port,'synthetic'],{stdio:'inherit'});
const nativeCode = await new Promise((resolve,reject)=>{nativeChild.once('error',reject);nativeChild.once('exit',resolve);});
const ignore = ignored.code===0, argv=pipe;
console.error('NB_BUN pid='+process.pid+' ignore='+Number(ignore)+' pipe='+Number(pipe)+' argv='+Number(argv)+' denials='+Number(denied&&nativeCode===0)+' network='+Number(network));
if(!ignore||!pipe||!denied||nativeCode!==0||!network) process.exit(1);
`;

export function createBrokerFixture(scratch: string) {
  // setup replaces this directory's DACL and propagates inherited ACL changes.
  // Keep host controls and the open journal outside that subtree.
  const boundary = join(scratch, 'boundary'); mkdirSync(boundary);
  const project = join(boundary, 'view'), runtime = join(boundary, 'runtime'), home = join(boundary, 'home'), host = join(scratch, 'host-project');
  for (const path of [project,runtime,home,join(home,'temp'),host]) mkdirSync(path);
  writeFileSync(join(project,'ordinary.txt'),'ordinary synthetic fixture');
  writeFileSync(join(host,'ordinary.txt'),'SYNTHETIC_HOST');
  const excluded = join(host,'.env'); writeFileSync(excluded,'SYNTHETIC_EXCLUDED');
  writeFileSync(join(project,'bun-fixture.js'),bunFixture);
  return {boundary, project, runtime, home, host, excluded, ambient: join(boundary,'ambient-probe')};
}

async function nativeCases(procs: ProcRegistry, helper: string, scratch: string, output: string, compiler: string) {
  const {boundary, project, runtime, home, host, excluded, ambient} = createBrokerFixture(scratch);
  const capturedNative = join(runtime,'null-broker-fixture.exe'), capturedBun = join(runtime,'bun.exe');
  copyFileSync(helper,capturedNative); copyFileSync(process.execPath,capturedBun);
  const capturedImages = {native: hash(readFileSync(capturedNative)), bun: hash(readFileSync(capturedBun))};
  const profile = `boite.null-broker.${randomUUID()}`, calls: Record<string,unknown>[] = [];
  const run = async (id: string, args: string[], env = selectedEnvironment(), timeout = 60000) => {
    const result = await boundedCapture(procs, `${compiler}-${id}`, helper,args,scratch,env,timeout);
    writeFileSync(join(output,`${compiler}-${id}.stdout.txt`),result.out);
    writeFileSync(join(output,`${compiler}-${id}.stderr.txt`),result.err);
    calls.push({id,command:[helper,...args],...result}); return result;
  };
  const {dlopen, FFIType, ptr} = await import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    CreateFileW:{args:[FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr,FFIType.u32,FFIType.u32,FFIType.ptr],returns:FFIType.ptr},
    CloseHandle:{args:[FFIType.ptr],returns:FFIType.i32},
    OpenProcess:{args:[FFIType.u32,FFIType.i32,FFIType.u32],returns:FFIType.ptr},
    WaitForSingleObject:{args:[FFIType.ptr,FFIType.u32],returns:FFIType.u32},
    TerminateProcess:{args:[FFIType.ptr,FFIType.u32],returns:FFIType.i32},
  });
  let prepared = false, credential: ReturnType<typeof kernel.symbols.CreateFileW> = null, connections = 0;
  const activeLeases: ExecutionProtections[]=[];
  const listener = Bun.listen({hostname:'127.0.0.1',port:0,socket:{open(socket){connections++; socket.end('SYNTHETIC_NETWORK');},data(){}}});
  const cleanups: string[] = [];
  const outcomes: Record<string, BrokerVerdict> = {};
  try {
    const security = Buffer.alloc(24); security.writeUInt32LE(24); security.writeUInt32LE(1,16);
    credential = kernel.symbols.CreateFileW(ptr(Buffer.from(`${excluded}\0`,'utf16le')),0x80000000,7,ptr(security),3,0,null);
    if (!credential || Number(credential) === -1) throw new Error('synthetic credential open failed');
    prepared = true;
    const windows = process.env.SystemRoot || 'C:\\Windows';
    const env = {PATH:`${runtime};${join(windows,'System32')}`,SystemRoot:windows,WINDIR:windows,
      COMSPEC:join(windows,'System32','cmd.exe'),HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,TEMP:join(home,'temp'),TMP:join(home,'temp'),
      CI:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL'};
    const targetArgs = (scenario: string) => ['--broker-fixture',scenario,'root',ambient,excluded,join(host,'ordinary.txt'),String(credential),String(process.pid),String(listener.port),'synthetic'];
    const checkHostPath = async (phase: 'before' | 'after') => {
      const hostPath = await run(`host-path-${phase}`,targetArgs('host-path'));
      if (hostPath.code !== 0 || hostPath.timedOut || hostPath.overflow || hostPath.err.trim() !== 'NB_HOST_PATH status=0x00000000 content=1') {
        throw new Error(`exact native host-path ${phase} setup incomplete: code=${hostPath.code} ${hostPath.err.trim()}`);
      }
    };
    await checkHostPath('before');
    const setup = await run('setup',['setup',profile,boundary,project,runtime,home]);
    if (setup.code !== 0 || setup.out !== 'protected-native-prepared' || setup.timedOut || setup.overflow) throw new Error('original setup incomplete');
    await checkHostPath('after');
    for (const scenario of ['off','pointers','rollback','native','handled','unhandled','root-exit','bun']) {
      const command = scenario === 'off' ? 'run-off' : scenario === 'rollback' ? 'run-rollback' : 'run-broker';
      const target = scenario === 'bun' ? capturedBun : capturedNative;
      const args = scenario === 'bun' ? [join(project,'bun-fixture.js'),ambient,excluded,join(host,'ordinary.txt'),String(credential),String(process.pid),`http://127.0.0.1:${listener.port}`,capturedNative] : targetArgs(scenario);
      const capture = await run(scenario,[command,profile,project,target,...args],env);
      const expectedImages = {root: scenario === 'bun' ? capturedImages.bun : capturedImages.native, native: capturedImages.native};
      let result = classifyBroker(capture.err,scenario,capture.timedOut,expectedImages);
      const primitive=classifyBroker(capture.err,'primitive',capture.timedOut,expectedImages);
      if(scenario!=='off'&&outcomes.off?.kind==='positive'&&primitive.kind==='negative'&&!capture.overflow&&!connections)result=primitive;
      else if (capture.overflow || (scenario !== 'unhandled' && capture.code !== 0) || connections) result = verdict('incomplete');
      outcomes[scenario] = result;
      /* A primitive failure cannot be relabelled a positive or silently skipped.
       * Preserve remaining cases as explicitly unrun rather than repeat failure. */
      if (['negative','unsupported','setup','timeout'].includes(result.kind)) break;
    }
    /* Lifecycle cases run through the same captured launcher. A held process
     * handle proves termination; no executable-name or guessed-PID kill. */
    for (const reason of ['cancel','revoke','expiry','launcher-death']) {
      if (Object.values(outcomes).some(r => ['negative','unsupported','setup','timeout'].includes(r.kind))) break;
      const id = `${compiler}-lifetime-${reason}`;
      let sessionClosed = false;
      const leases = new ExecutionProtections({available:()=>true, async open(policy,check) {
        /* Diagnostic session only: prerequisite still performs an actual LPAC
         * launch. This does not alter WindowsExecutionBoundary admission. */
        const baseline=await check(helper,['run-off',profile,project,capturedNative,...targetArgs('off')],scratch,env);
        if(baseline.code!==0||classifyBroker(baseline.stderr,'off').kind!=='positive')throw new Error('lifecycle LPAC prerequisite incomplete');
        return {launch(command,args,cwd) {
          assertExecutionPolicy(policy);
          if(sessionClosed||command!==capturedNative||cwd!==project)throw new Error('captured diagnostic launch mismatch');
          return {command:helper,args:['run-broker',profile,project,capturedNative,...args],cwd:scratch,env};
        },flush(){},close(){sessionClosed=true;}};
      }},async (controlId,command,args,cwd,environment)=>{
        const c=await boundedCapture(procs,controlId,command,args,cwd,environment??env,30000);
        calls.push({id:controlId,kind:'lifecycle-prerequisite',...c});return {code:c.code??125,stdout:c.out,stderr:c.err};
      },scope=>procs.stopAndWait(scope),scope=>procs.liveCount(scope));
      activeLeases.push(leases);
      await leases.install(id,{scope:{kind:'job',id,associationId:'synthetic',grantRevision:1},checkout:project,credentialPaths:[excluded],
        executables:[capturedNative],expiresAt:Date.now()+(reason==='expiry'?20000:90000)},()=>{});
      const launch=leases.launch(id,capturedNative,targetArgs('lifetime'),{cwd:project});
      if(!launch)throw new Error('missing captured lifecycle launch');
      const child = procs.spawnPiped(id,launch.command,launch.args,{cwd:launch.cwd,env:launch.env,agentRoot:false}); child.proc.stdin.end();
      const held: {pid:number; handle:NonNullable<ReturnType<typeof kernel.symbols.OpenProcess>>}[] = []; let text = '', ready = false, tooLarge = false;
      const reader = child.proc.stderr.getReader(), stdout = child.proc.stdout.getReader();
      const collecting = (async () => {
        const decoder = new TextDecoder();
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          text += decoder.decode(next.value,{stream:true});
          if (text.length > 2*1024*1024) {tooLarge=true;procs.killTree(id);break;}
          for (const row of parse(text) ?? []) if (row.tag === 'BIND' && decimal(row.pid) && !held.some(h=>h.pid===Number(row.pid))) {
            const pid = Number(row.pid), handle = kernel.symbols.OpenProcess(0x100000,0,pid);
            if (handle) held.push({pid,handle});
          }
          if (text.includes('NB_READY wait=1')) ready=true;
        }
      })();
      const discarding = (async()=>{let bytes=0;for(;;){const next=await stdout.read();if(next.done)break;bytes+=next.value.length;if(bytes>65536){tooLarge=true;procs.killTree(id);break;}}})();
      const deadline = Date.now()+10000;
      while (!ready && procs.liveCount(id) && Date.now()<deadline) await Bun.sleep(25);
      let action = false;
      if (reason==='revoke') {await leases.revoke(id);action=sessionClosed;}
      else if(reason==='expiry') {
        const expires=Date.now()+25000;
        while(procs.liveCount(id)&&Date.now()<expires)await Bun.sleep(25);
        action=sessionClosed&&!procs.liveCount(id);
      } else if(reason==='launcher-death') {
        const launcher=kernel.symbols.OpenProcess(0x100001,0,child.record.pid);
        if(launcher){action=kernel.symbols.TerminateProcess(launcher,125)!==0;kernel.symbols.CloseHandle(launcher);}
      } else {await procs.stopAndWait(id);action=!procs.liveCount(id);}
      if(!action||!ready)await procs.stopAndWait(id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([Promise.all([collecting,discarding]).then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),6000);})]); clearTimeout(timer);
      if (!drained) await Promise.allSettled([reader.cancel(),stdout.cancel()]);
      const exited = held.length===2 && held.every(h=>kernel.symbols.WaitForSingleObject(h.handle,5000)===0);
      const closed = held.every(h=>kernel.symbols.CloseHandle(h.handle)!==0);
      writeFileSync(join(output,`${compiler}-lifetime-${reason}.stderr.txt`),text);
      calls.push({id,reason,ready,action,drained,held:held.map(h=>h.pid),exited,closed,tooLarge});
      outcomes[reason] = ready && action && drained && exited && closed && !tooLarge ? verdict('positive') : verdict('incomplete');
      await leases.close();
    }
  } finally {
    for(const lease of activeLeases)try{await lease.close();}catch(error){cleanups.push(`lease cleanup ${String(error)}`);}
    listener.stop(true);
    if (credential && !kernel.symbols.CloseHandle(credential)) cleanups.push('synthetic credential close failed'); kernel.close();
    if (prepared) {
      const userenv = dlopen('userenv.dll',{DeleteAppContainerProfile:{args:[FFIType.ptr],returns:FFIType.i32}});
      try {const status=userenv.symbols.DeleteAppContainerProfile(ptr(Buffer.from(`${profile}\0`,'utf16le')));if(status!==0&&(status>>>0)!==0x80070002)cleanups.push(`profile cleanup ${status>>>0}`);} finally {userenv.close();}
    }
  }
  const expected=['off','pointers','rollback','native','handled','unhandled','root-exit','bun','cancel','revoke','expiry','launcher-death'];
  const clean=!connections&&!cleanups.length, complete=clean&&expected.every(name=>outcomes[name]?.kind==='positive');
  const negative=clean&&outcomes.off?.kind==='positive'&&Object.values(outcomes).some(r=>r.kind==='negative');
  return {capturedImages,calls,outcomes,connections,cleanupErrors:cleanups,verdict:complete?verdict('positive'):negative?verdict('negative'):verdict('incomplete')};
}

if (import.meta.main) {
  const [output,mode] = process.argv.slice(2), compileOnly = mode === '--compile-only';
  if (!output || !isAbsolute(output) || (mode && !compileOnly)) throw new Error('usage: bun packages/core/test/windows-null-broker-spike.ts <fresh absolute artifact directory> [--compile-only]');
  if (!compileOnly && (process.platform !== 'win32' || process.env.BOITE_TEST_NULL_BROKER !== '1')) throw new Error('requires Windows and BOITE_TEST_NULL_BROKER=1; no native fixture allocated');
  if (existsSync(output)) throw new Error('fresh artifact directory required');
  const source = brokerSource(readFileSync(production,'utf8'));
  mkdirSync(output,{recursive:true});
  const generated = join(output,'null-broker.c'); writeFileSync(generated,source);
  copyFileSync(production,join(output,'production-reference.c.txt'));
  const hashes: Record<string,string> = {};
  for (const file of readdirSync(diagnostics).filter(f=>/\.[ch]$/.test(f))) {copyFileSync(join(diagnostics,file),join(output,file));hashes[file]=hash(readFileSync(join(diagnostics,file)));}
  for (const file of ['startup-site.h','startup-site.json']) {const path=join(import.meta.dir,'../../../tests/diagnostics/windows-debug-map',file);copyFileSync(path,join(output,file));hashes[file]=hash(readFileSync(path));}
  const results: Record<string,unknown>[]=[];
  const manifest={platform:process.platform,kernel:release(),bun:Bun.version,compileOnly,productionHash,generatedSha256:hash(source),runnerSha256:hash(readFileSync(import.meta.path)),hashes,
    productionAccepted:false,experimentComplete:false,results};
  const save=()=>writeFileSync(join(output,'broker.json'),JSON.stringify(manifest,null,2)+'\n'); save();
  const compilers=process.platform==='win32'?[{name:'sdk',path:Bun.which('clang')},{name:'mingw',path:'C:\\mingw64\\bin\\gcc.exe'}]:[{name:'mingw-cross',path:Bun.which('x86_64-w64-mingw32-gcc')}];
  let failed=false;
  for (const compiler of compilers) {
    const result: Record<string,unknown>={name:compiler.name};results.push(result);
    const scratch=mkdtempSync(join(tmpdir(),'boite-null-broker-')),journal=new Journal(join(scratch,'journal.db')),procs=new ProcRegistry(journal,new Bus());
    try {
      if(!compiler.path||!existsSync(compiler.path))throw new Error(`compiler unavailable: ${compiler.name}`);
      const helper=join(output,`null-broker-${compiler.name}.exe`),args=['-std=c11','-O2','-Wall','-Wextra','-Werror',generated,'-o',helper,
        ...(process.platform==='win32'&&/clang/i.test(compiler.path)?[]:['-static']),'-luserenv','-ladvapi32','-lshell32','-luser32','-lws2_32'];
      result.compileCommand=[compiler.path,...args];
      const built=await boundedCapture(procs,`compile-${compiler.name}`,compiler.path,args,output,selectedEnvironment(),90000);result.compile=built;
      writeFileSync(join(output,`${compiler.name}-compile.stdout.txt`),built.out);writeFileSync(join(output,`${compiler.name}-compile.stderr.txt`),built.err);
      if(built.code!==0||built.timedOut||built.overflow)throw new Error('strict compile failed');
      result.helperSha256=hash(readFileSync(helper));
      if(!compileOnly) {const native=await nativeCases(procs,helper,scratch,output,compiler.name);result.native=native;result.verdict=native.verdict;if(!native.verdict.experimentComplete)failed=true;}
      console.log(`NULL_BROKER compiler=${compiler.name} compiled=1 native=${!compileOnly} experimentComplete=${result.verdict?(result.verdict as BrokerVerdict).experimentComplete:0} productionAccepted=0`);
    } catch(error) {result.error=String(error);failed=true;console.error(String(error));}
    finally {
      const errors:string[]=[];
      for(const [name,cleanup] of [['processes',()=>procs.killAll()],['registry',()=>procs.close()],['journal',()=>journal.close()]] as const)try{await cleanup();}catch(error){errors.push(`${name}: ${String(error)}`);}
      if(!errors.length)try{rmSync(scratch,{recursive:true,force:true});}catch(error){errors.push(`scratch: ${String(error)}`);}
      if(errors.length){result.cleanupErrors=errors;result.scratchRetained=scratch;failed=true;}
      save();
    }
  }
  manifest.experimentComplete=!failed&&!compileOnly&&combineVerdicts(results.map(r=>r.verdict as BrokerVerdict).filter(Boolean));
  save();process.exitCode=failed||(!compileOnly&&!manifest.experimentComplete)?1:0;
}
