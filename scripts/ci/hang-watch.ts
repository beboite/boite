import { existsSync, mkdirSync, statfsSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join, parse } from 'node:path';
import { hangReportExpression } from '../../tests/e2e/lib/hang-report.ts';

// A `bun test` run that outlives its deadline is stopped with evidence before
// the job's own limit cancels it. A cancelled job kept no log and no artifact
// (E2E 2/3 of run 39321123064, 2026-10-19): the runner never got to the upload
// step. The run goes through the Bun inspector, which names every test as it
// starts and ends (TestReporter) and lets the watch ask the test process for
// its pages and shells (tests/e2e/lib/hang-report.ts). At the deadline the
// watch writes what it saw to the report folder, kills the run's process tree
// and the run fails.

/**
 * Kept between the deadline and the job's limit: about a minute of report,
 * the tree kill, the failure-captures upload and the post steps. No healthy
 * E2E shard on main or a pull request came near it: from 2026-10-12 to
 * 2026-10-19, 2831 passing shards ran their tests in 7.6 min at the median,
 * 19.2 min at most, and the whole job in 24.5 min at most, under a 35 min limit.
 */
export const REPORT_RESERVE_MS = 4 * 60_000;
/** How long `bun test --inspect-wait` gets to print its inspector address and accept the watch. */
const CONNECT_TIMEOUT_MS = 60_000;
/** A test process whose JavaScript thread answers nothing in this long is blocked in synchronous code. */
const ANSWER_TIMEOUT_MS = 10_000;
/** How long the test process gets to write its own report (each source has 20 s). */
const IN_PROCESS_REPORT_MS = 30_000;
const LISTING_TIMEOUT_MS = 20_000;
const BROWSER_PROBE_TIMEOUT_MS = 3_000;
const OUTPUT_TAIL_CHARS = 64 * 1024;
const TOP_PROCESSES = 15;
const SAMPLE_EVERY_MS = 60_000;
const SAMPLES = 45;

/** When a run started by a job that began at `jobStartedMs`, under `jobMinutes`, must stop. */
export function deadlineFor(jobStartedMs: number, jobMinutes: number): number {
  return jobStartedMs + jobMinutes * 60_000 - REPORT_RESERVE_MS;
}

/** `bun test` arguments with the inspector on: it waits for the watch, on a port the system picks. */
export function inspectedTestCommand(command: string[]): string[] {
  const at = command.indexOf('test');
  if (at < 0) throw new Error(`not a bun test command: ${command.join(' ')}`);
  return [...command.slice(0, at + 1), '--inspect-wait=127.0.0.1:0', ...command.slice(at + 1)];
}

/** The address `bun test --inspect-wait` prints on stderr before it runs anything. */
export function inspectorAddress(stderr: string): string | undefined {
  return /Bun Inspector -+\r?\nListening:\r?\n\s*(ws:\/\/\S+)\r?\n/.exec(stderr)?.[1];
}

interface Found { name: string; url: string; line: number; type: string; parentId?: number }
export interface RunningTest { name: string; file: string; line: number; forMs: number }

/** What the inspector's TestReporter said: tests found, started and ended. */
export class TestProgress {
  #found = new Map<number, Found>();
  #started = new Map<number, number>();
  #lastFile: string | undefined;
  lastEnded: { name: string; file: string; status: string; at: number } | undefined;
  ended = 0;
  /** One line per ended test: bun holds its own result lines while its stderr is a pipe. */
  readonly log: string[] = [];

  handle(message: { method?: string; params?: Record<string, unknown> }, now = Date.now()): void {
    const params = message.params ?? {};
    const id = params.id as number;
    if (message.method === 'TestReporter.found') {
      const found = params as unknown as Found;
      this.#found.set(id, found);
      this.#lastFile = found.url;
    } else if (message.method === 'TestReporter.start') {
      this.#started.set(id, now);
    } else if (message.method === 'TestReporter.end') {
      const started = this.#started.get(id);
      this.#started.delete(id);
      this.ended += 1;
      this.lastEnded = { name: this.name(id), file: this.#found.get(id)?.url ?? '?', status: String(params.status), at: now };
      this.log.push(`${new Date(now).toISOString().slice(11, 19)}\t${this.lastEnded.status}\t${started === undefined ? '?' : now - started} ms\t${this.lastEnded.name}\t${this.lastEnded.file}`);
    }
  }

  /** `describe > test`, as bun prints it. */
  name(id: number): string {
    const parts: string[] = [];
    for (let at: number | undefined = id; at !== undefined;) {
      const found = this.#found.get(at);
      if (found === undefined) {
        parts.unshift(`#${at}`);
        break;
      }
      parts.unshift(found.name);
      at = found.parentId;
    }
    return parts.join(' > ');
  }

  running(now = Date.now()): RunningTest[] {
    return [...this.#started].map(([id, at]) => ({ name: this.name(id), file: this.#found.get(id)?.url ?? '?', line: this.#found.get(id)?.line ?? 0, forMs: now - at }));
  }

  /** The file whose tests were found last: the one bun is in, even while a hook runs before its first test. */
  get file(): string | undefined {
    return this.#lastFile;
  }
}

/** The watch's end of the Bun inspector of a `bun test --inspect-wait` run. */
export class TestInspector {
  #socket: WebSocket;
  #next = 1;
  #replies = new Map<number, (result: unknown) => void>();

  private constructor(socket: WebSocket, progress: TestProgress) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== undefined) this.#replies.get(message.id)?.(message.result);
      else progress.handle(message);
    });
  }

  static async connect(url: string, progress: TestProgress, timeoutMs = CONNECT_TIMEOUT_MS): Promise<TestInspector> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the Bun inspector at ${url} did not accept the watch within ${timeoutMs} ms`)), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`the Bun inspector at ${url} refused the watch`)); }, { once: true });
    });
    const inspector = new TestInspector(socket, progress);
    // `Inspector.initialized` lets `--inspect-wait` start the run.
    for (const method of ['Inspector.enable', 'TestReporter.enable', 'Runtime.enable', 'Inspector.initialized']) inspector.#send(method, {});
    return inspector;
  }

  #send(method: string, params: Record<string, unknown>): number {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return id;
  }

  /** The value of `expression` in the test process, or undefined when its JavaScript thread does not answer in time. */
  async evaluate(expression: string, timeoutMs = ANSWER_TIMEOUT_MS): Promise<{ value?: unknown } | undefined> {
    const id = this.#send('Runtime.evaluate', { expression, returnByValue: true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#replies.delete(id); resolve(undefined); }, timeoutMs);
      this.#replies.set(id, (result) => {
        clearTimeout(timer);
        this.#replies.delete(id);
        resolve((result as { result?: { value?: unknown } } | undefined)?.result ?? {});
      });
    });
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      /* already closed */
    }
  }
}

export interface ProcessRow { pid: number; ppid: number; name: string; memoryMb: number; cpuSeconds: number | null; started: string; commandLine: string }

/** Every process of the machine, from one PowerShell (Windows) or `ps` listing. */
export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,UserModeTime,KernelModeTime,@{n='Started';e={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }}},CommandLine | ConvertTo-Json -Compress";
    const text = await output(['powershell', '-NoProfile', '-Command', script]);
    const rows = JSON.parse(text) as Array<{ ProcessId: number; ParentProcessId: number; Name: string; WorkingSetSize: number; UserModeTime: number | null; KernelModeTime: number | null; Started: string; CommandLine: string | null }>;
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      name: row.Name,
      memoryMb: Math.round(Number(row.WorkingSetSize) / 1048576),
      // 100 ns units.
      cpuSeconds: row.UserModeTime === null || row.KernelModeTime === null ? null : Math.round((Number(row.UserModeTime) + Number(row.KernelModeTime)) / 1e5) / 100,
      started: row.Started,
      commandLine: row.CommandLine ?? '',
    }));
  }
  const text = await output(['ps', '-eo', 'pid=,ppid=,rss=,etime=,args=']);
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => {
    const [pid, ppid, rss, etime, ...args] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), name: parse(args[0] ?? '').base, memoryMb: Math.round(Number(rss) / 1024), cpuSeconds: null, started: `${etime} ago`, commandLine: args.join(' ') };
  });
}

async function output(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: LISTING_TIMEOUT_MS });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (child.signalCode !== null) throw new Error(`${command[0]} gave no listing within ${LISTING_TIMEOUT_MS} ms`);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr.slice(0, 300)}`);
  return stdout;
}

/** `root` and every process under it. */
export function descendants(rows: ProcessRow[], root: number): ProcessRow[] {
  const ids = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!ids.has(row.pid) && ids.has(row.ppid) && row.pid !== row.ppid) {
        ids.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => ids.has(row.pid));
}

function processTable(rows: ProcessRow[]): string {
  return rows.map((row) => `${row.pid}\t${row.ppid}\t${row.name}\t${row.memoryMb} MB\tcpu ${row.cpuSeconds ?? '?'} s\t${row.started}\t${row.commandLine}`).join('\n');
}

/** `/json/version` and `/json/list` of every browser in the tree that has a debugging port. */
async function browsers(tree: ProcessRow[]): Promise<string> {
  const ports = [...new Set(tree.filter((row) => !row.commandLine.includes('--type=')).map((row) => /--remote-debugging-port=(\d+)/.exec(row.commandLine)?.[1]).filter((port): port is string => port !== undefined))];
  if (ports.length === 0) return '(no browser with a debugging port in the tree)';
  const ask = (url: string) => fetch(url, { signal: AbortSignal.timeout(BROWSER_PROBE_TIMEOUT_MS) }).then((response) => response.text(), (error: unknown) => `(no answer: ${error instanceof Error ? error.message : String(error)})`);
  const texts = await Promise.all(ports.map(async (port) => {
    const [version, list] = await Promise.all([ask(`http://127.0.0.1:${port}/json/version`), ask(`http://127.0.0.1:${port}/json/list`)]);
    return `== port ${port}\n/json/version: ${version.replace(/\s+/g, ' ')}\n/json/list: ${list.replace(/\s+/g, ' ')}`;
  }));
  return texts.join('\n\n');
}

export interface Sample { at: number; freeMb: number; running: string[] }

/** One line a minute of free memory and running tests, the newest `SAMPLES` kept for the report. */
export function sampleEveryMinute(progress: TestProgress): { samples: Sample[]; stop: () => void } {
  const samples: Sample[] = [];
  const take = () => {
    samples.push({ at: Date.now(), freeMb: Math.round(freemem() / 1048576), running: progress.running().map((test) => test.name) });
    if (samples.length > SAMPLES) samples.shift();
  };
  take();
  const timer = setInterval(take, SAMPLE_EVERY_MS);
  timer.unref();
  return { samples, stop: () => clearInterval(timer) };
}

export interface HangInput {
  /** The report folder. */
  dir: string;
  /** The `bun test` process, captured at spawn. */
  pid: number;
  deadline: number;
  progress: TestProgress;
  inspector: TestInspector | undefined;
  output: string;
  samples: Sample[];
}

/**
 * Writes the report of a run stopped at its deadline and returns its summary:
 * `summary.txt` (the tests running and since when, the last that ended, the
 * file bun is in, whether the test process answered), `test-process.txt`
 * (its open pages and shells, from tests/e2e/lib/hang-report.ts),
 * `process-tree.txt`, `browsers.txt` (each browser's `/json/list`),
 * `machine.txt` (memory, disk, the largest processes), `tests.txt` (every
 * test that ended, as the inspector saw it) and `output-tail.txt`.
 * Bun gives no open-handle list (`process.getActiveResourcesInfo` returns
 * nothing) and no stack of a test that awaits: its inspector answers only
 * when the JavaScript thread is free and pauses only when JavaScript runs.
 */
export async function writeHangReport(input: HangInput): Promise<string> {
  const { dir, pid, progress, inspector } = input;
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const inProcessPath = join(dir, 'test-process.txt');

  const inProcess = (async () => {
    if (inspector === undefined) return 'no inspector connection';
    const asked = Date.now();
    const answer = await inspector.evaluate(hangReportExpression(inProcessPath));
    if (answer === undefined) return `no answer within ${ANSWER_TIMEOUT_MS} ms: its JavaScript thread is blocked in synchronous code (a loop, a spawnSync, a synchronous file or lock wait)`;
    const sources = Number(answer.value ?? -1);
    if (sources < 0) return `answered in ${Date.now() - asked} ms, without tests/e2e/lib/hang-report.ts loaded`;
    const until = Date.now() + IN_PROCESS_REPORT_MS;
    while (!existsSync(inProcessPath) && Date.now() < until) await Bun.sleep(200);
    return existsSync(inProcessPath)
      ? `answered in ${Date.now() - asked} ms; its ${sources} page and shell source(s) are in test-process.txt`
      : `answered, but its report of ${sources} source(s) was not written within ${IN_PROCESS_REPORT_MS} ms`;
  })();

  const machine = (async () => {
    let rows: ProcessRow[];
    try {
      rows = await listProcesses();
    } catch (error) {
      const reason = `(could not list processes: ${error instanceof Error ? error.message : String(error)})`;
      writeFileSync(join(dir, 'process-tree.txt'), reason);
      return { tree: [] as ProcessRow[], browsersText: reason };
    }
    const tree = descendants(rows, pid);
    writeFileSync(join(dir, 'process-tree.txt'), `pid\tparent\tname\tmemory\tcpu\tstarted\tcommand line\n${processTable(tree)}\n`);
    let disk = '';
    try {
      const stats = statfsSync(dir);
      disk = `Disk of ${dir}: ${Math.round((stats.bavail * stats.bsize) / 1073741824)} GB free of ${Math.round((stats.blocks * stats.bsize) / 1073741824)} GB`;
    } catch (error) {
      disk = `Disk: (unknown: ${error instanceof Error ? error.message : String(error)})`;
    }
    const top = [...rows].sort((a, b) => b.memoryMb - a.memoryMb).slice(0, TOP_PROCESSES);
    writeFileSync(join(dir, 'machine.txt'), `Memory: ${Math.round(freemem() / 1048576)} MB free of ${Math.round(totalmem() / 1048576)} MB\n${disk}\nProcesses: ${rows.length}\n\nLargest ${TOP_PROCESSES} by memory:\n${processTable(top)}\n`);
    return { tree, browsersText: await browsers(tree) };
  })();

  const [inProcessText, { tree, browsersText }] = await Promise.all([inProcess, machine]);
  writeFileSync(join(dir, 'browsers.txt'), `${browsersText}\n`);
  writeFileSync(join(dir, 'output-tail.txt'), input.output.slice(-OUTPUT_TAIL_CHARS));
  writeFileSync(join(dir, 'tests.txt'), `ended\tstatus\ttook\ttest\tfile\n${progress.log.join('\n')}\n`);

  const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
  const running = progress.running(now);
  const last = progress.lastEnded;
  const summary = [
    `The run passed its deadline, ${new Date(input.deadline).toISOString()}, and was stopped.`,
    running.length > 0
      ? `Running: ${running.map((test) => `"${test.name}" (${test.file}:${test.line}) for ${minutes(test.forMs)}`).join('; ')}`
      : `Running: no test; bun is in ${progress.file ?? 'no file yet'} (a hook, a file load or the end of the run)`,
    `Last ended: ${last === undefined ? 'none' : `"${last.name}" (${last.file}), ${last.status}, ${minutes(now - last.at)} ago`}; ${progress.ended} ended in all, in tests.txt`,
    `Test process ${pid}: ${inProcessText}`,
    `Process tree: ${tree.length} process(es), in process-tree.txt`,
    `Free memory, one sample a minute: ${input.samples.map((sample) => `${new Date(sample.at).toISOString().slice(11, 16)} ${sample.freeMb} MB`).join(', ')}`,
  ].join('\n');
  writeFileSync(join(dir, 'summary.txt'), `${summary}\n`);
  return summary;
}
