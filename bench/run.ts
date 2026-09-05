import { readdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import {
  claudeTurn,
  compiledCoreIdleRss,
  coreColdStart,
  coreIdleRss,
  CORE_ENTRY,
  echoTurns,
  idleThreads,
  shellRun,
  type ClaudeRun,
  type ColdStart,
  type EchoRun,
  type IdleThreads,
  type ShellRun,
} from './boite2.ts';
import {
  liveApp,
  serverBuilt,
  serverColdStart,
  serverIdleRss,
  threadsIdle,
  type LegacyThreads,
  type LiveApp,
} from './legacy.ts';
import { kb, mb, median, ms, percentile, today, write, type Report, type Row } from './lib/report.ts';

const RESULTS = join(import.meta.dir, 'results');
const NONE = 'n/a';

interface Raw {
  boite2: {
    /** Which core the rows below ran, written down because a bundle and the sources differ. */
    coreEntry?: string | null;
    coldStart: ColdStart | null;
    coreIdleRssBytes: number | null;
    compiledCoreIdleRssBytes?: number | null;
    threads: IdleThreads | null;
    echoAtDefault: EchoRun | null;
    echoAtFifty: EchoRun | null;
    shell: ShellRun | null;
    claude: ClaudeRun | null;
    /** Set when the claude row was carried over from that date instead of measured. */
    claudeFrom?: string | null;
  };
  legacy: {
    coldStartMs: number[] | null;
    idleRssBytes: number | null;
    threads: LegacyThreads | null;
    app: LiveApp | null;
  };
}

const notMeasured: { what: string; why: string }[] = [];

function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  process.stdout.write(`[bench] ${name}\n`);
  return run().catch((error: unknown) => {
    const why = error instanceof Error ? error.message : String(error);
    process.stdout.write(`[bench] ${name} failed: ${why}\n`);
    notMeasured.push({ what: name, why });
    return null;
  });
}

/**
 * A real claude turn spends tokens on the user's account, so a run without
 * `BOITE_BENCH_CLAUDE` keeps the last one that was measured rather than
 * dropping the row from the table.
 */
function carriedClaude(): { run: ClaudeRun; date: string } | null {
  let names: string[];
  try {
    names = readdirSync(RESULTS).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  for (const name of names.sort().reverse()) {
    try {
      const previous = JSON.parse(readFileSync(join(RESULTS, name), 'utf8')) as Report;
      const claude = (previous.raw as unknown as Raw).boite2.claude;
      if (claude !== null && claude !== undefined) return { run: claude, date: previous.date };
    } catch {
      continue;
    }
  }
  return null;
}

async function measure(): Promise<Raw> {
  const coldStart = await step<ColdStart>('boite2 core cold start', () => coreColdStart(5));
  const coreIdleRssBytes = await step<number>('boite2 core idle rss', () => coreIdleRss());
  const compiledCoreIdleRssBytes = await step<number | null>('boite2 compiled core idle rss', () =>
    compiledCoreIdleRss(),
  );
  const threads = await step<IdleThreads>('boite2 idle threads', () => idleThreads());
  const echoAtDefault = await step<EchoRun>('boite2 50 echo turns at cap 6', () => echoTurns(6));
  const echoAtFifty = await step<EchoRun>('boite2 50 echo turns at cap 50', () => echoTurns(50));
  const shell = await step<ShellRun | null>('boite2 shell exe', () => shellRun());

  let claude: ClaudeRun | null = null;
  let claudeFrom: string | null = null;
  if (process.env.BOITE_BENCH_CLAUDE === '1') {
    claude = await step<ClaudeRun>('boite2 one real claude turn', () => claudeTurn());
  } else {
    const carried = carriedClaude();
    if (carried !== null) {
      claude = carried.run;
      claudeFrom = carried.date;
    }
    notMeasured.push({
      what: 'claude.turn',
      why:
        carried === null
          ? 'BOITE_BENCH_CLAUDE was not 1, so no real account was used'
          : `BOITE_BENCH_CLAUDE was not 1, so no real account was used; the row below is the one measured on ${carried.date}`,
    });
  }

  let coldStartMs: number[] | null = null;
  let idleRssBytes: number | null = null;
  let legacyThreads: LegacyThreads | null = null;
  if (serverBuilt()) {
    coldStartMs = await step<number[]>('legacy server cold start', () => serverColdStart(5));
    idleRssBytes = await step<number>('legacy server idle rss', () => serverIdleRss());
    legacyThreads = await step<LegacyThreads>('legacy ten pty threads', () => threadsIdle(10));
  } else {
    notMeasured.push({
      what: 'every legacy server figure',
      why: 'target/release/boite-server.exe is missing, build it with cargo build --release -p boite-server',
    });
  }
  const app = await step<LiveApp>('legacy desktop app, live', async () => liveApp());

  return {
    boite2: {
      coreEntry: CORE_ENTRY,
      coldStart,
      coreIdleRssBytes,
      compiledCoreIdleRssBytes,
      threads,
      echoAtDefault,
      echoAtFifty,
      shell,
      claude,
      claudeFrom,
    },
    legacy: { coldStartMs, idleRssBytes, threads: legacyThreads, app },
  };
}

function buildRows(raw: Raw): Row[] {
  const rows: Row[] = [];
  const { coldStart, coreIdleRssBytes, threads, echoAtDefault, echoAtFifty, shell, claude } = raw.boite2;
  const entry = raw.boite2.coreEntry ?? 'packages/core/src/main.ts';
  const compiledIdle = raw.boite2.compiledCoreIdleRssBytes ?? null;
  const claudeFrom = raw.boite2.claudeFrom ?? null;
  const legacy = raw.legacy;
  const app = legacy.app;
  const live = app !== null && app.found;

  const add = (metric: string, boite2: string, legacyValue: string, note: string): void => {
    rows.push({ metric, boite2, legacy: legacyValue, note });
  };

  add(
    'core cold start, spawn to ready line',
    coldStart === null ? NONE : ms(median(coldStart.readyMs)),
    NONE,
    `median of 5, fresh data dir each, Boite 2 ran ${entry}. Boite 2 prints \`boite-core ready\`, the legacy server prints no such line`,
  );
  add(
    'core cold start, spawn to first HTTP answer',
    coldStart === null ? NONE : ms(median(coldStart.healthMs)),
    legacy.coldStartMs === null ? NONE : ms(median(legacy.coldStartMs)),
    'median of 5. Boite 2 on /health, legacy on / with any status',
  );
  add(
    'core idle RSS after 3 s',
    coreIdleRssBytes === null ? NONE : mb(coreIdleRssBytes),
    legacy.idleRssBytes === null ? NONE : mb(legacy.idleRssBytes),
    `working set of the one server process. Boite 2 is bun running ${entry}, legacy is a compiled binary`,
  );
  add(
    'core idle RSS, compiled exe',
    compiledIdle === null ? NONE : mb(compiledIdle),
    legacy.idleRssBytes === null ? NONE : mb(legacy.idleRssBytes),
    compiledIdle === null
      ? 'packages/core/dist/boite-core.exe is missing, build it with bun run build:core:exe'
      : 'the same core as `bun build --compile` output: one file, its own Bun runtime inside, no node_modules',
  );
  add(
    '50 idle threads, core RSS delta',
    threads === null ? NONE : mb(threads.at50Bytes - threads.baseBytes),
    NONE,
    threads === null
      ? ''
      : `threads created, no turn started. Five reads per stage, median kept, and the five baseline reads spanned ${mb(threads.noiseBytes)}`,
  );
  add(
    '100 idle threads, core RSS delta',
    threads === null ? NONE : mb(threads.at100Bytes - threads.baseBytes),
    NONE,
    threads === null
      ? ''
      : `the second fifty moved it by ${kb(threads.at100Bytes - threads.at50Bytes)}`,
  );
  add(
    'cost of one idle thread',
    threads === null ? NONE : kb(threads.perThreadBytes),
    legacy.threads === null ? NONE : mb(legacy.threads.perThreadBytes),
    'the Boite 2 figure is negative because the core working set fell over the run: a thread is a journal row and costs no measurable memory. A legacy thread is a PTY, a cmd.exe and its conhost.exe, ten of them measured',
  );

  const addEcho = (run: EchoRun | null, cap: number): void => {
    const label = `50 echo turns at cap ${cap}`;
    add(
      `${label}, wall time`,
      run === null ? NONE : ms(run.wallMs),
      NONE,
      'fifty threads each sent one 300 word prompt at the same moment, perAccountConcurrency raised to the same cap',
    );
    add(
      `${label}, first delta median`,
      run === null ? NONE : ms(median(run.firstDeltaMs)),
      NONE,
      'turns.start to the first message.delta on that thread, queue wait included',
    );
    add(`${label}, first delta p95`, run === null ? NONE : ms(percentile(run.firstDeltaMs, 0.95)), NONE, '');
    add(
      `${label}, core peak RSS`,
      run === null ? NONE : mb(run.peakBytes),
      NONE,
      run === null
        ? ''
        : `sampled every 200 ms, ${run.samples} samples ${Math.round(run.cadenceMs)} ms apart in practice`,
    );
    add(
      `${label}, turns queued at peak RSS`,
      run === null ? NONE : String(run.queuedAtPeak),
      NONE,
      run === null ? '' : `highest queued count of the run: ${run.maxQueued}`,
    );
  };
  addEcho(echoAtDefault, 6);
  addEcho(echoAtFifty, 50);

  add(
    'desktop app, spawn to core answering',
    shell === null ? NONE : ms(shell.startMs),
    NONE,
    'the hidden shell exe starting a core of its own. The legacy app was not launched',
  );
  add(
    'desktop app idle RSS, shell process',
    shell === null ? NONE : mb(shell.shellBytes),
    live && app !== null ? mb(app.appBytes) : NONE,
    'five seconds after the core answered, against the legacy app that was already running',
  );
  add(
    'desktop app idle RSS, WebView2',
    shell === null ? NONE : `${mb(shell.webviewBytes)} (${shell.webviewCount})`,
    live && app !== null ? `${mb(app.webviewBytes)} (${app.webviewCount})` : NONE,
    'every msedgewebview2.exe in the tree, count in brackets',
  );
  add(
    'desktop app idle RSS, its core or server',
    shell === null ? NONE : mb(shell.coreBytes),
    NONE,
    'Boite 2 starts a core process. The legacy desktop app has no server process, it is the server',
  );
  add(
    'desktop app RSS, everything it owns',
    shell === null ? NONE : mb(shell.totalBytes),
    live && app !== null ? mb(app.namedTotalBytes) : NONE,
    'Boite 2: the whole exe tree. Legacy: app, WebView2, claude.exe and boite-mcp.exe only, because the rest of its tree is whatever the user is running in its terminals, this bench included',
  );
  add(
    'agent CLI processes in that tree',
    '0',
    live && app !== null ? `${mb(app.claudeBytes)} (${app.claudeCount} claude.exe)` : NONE,
    'a Boite 2 thread owns no CLI process while no turn runs',
  );
  add(
    'MCP host processes in that tree',
    '0',
    live && app !== null ? `${mb(app.mcpBytes)} (${app.mcpCount} boite-mcp.exe)` : NONE,
    'Boite 2 ships no MCP host yet',
  );

  add(
    'one real claude turn, first delta',
    claude === null ? NONE : ms(claude.firstDeltaMs),
    NONE,
    claude === null
      ? 'BOITE_BENCH_CLAUDE was not 1'
      : `Default account, prompt: Reply with exactly the word: pong, answer: ${claude.text}${
          claudeFrom === null ? '' : `. Measured on ${claudeFrom} and carried over, this run spent no tokens`
        }`,
  );
  add('one real claude turn, total', claude === null ? NONE : ms(claude.totalMs), NONE, '');
  add(
    'one real claude turn, peak claude.exe RSS',
    claude === null ? NONE : mb(claude.peakBytes),
    live && app !== null && app.claudeCount > 0
      ? `${mb(app.claudeBytes / app.claudeCount)} per live claude.exe`
      : NONE,
    'sampled every 200 ms. The legacy figure is the average of the CLIs its running app holds',
  );

  return rows;
}

function closingNotes(raw: Raw): void {
  notMeasured.push({
    what: "the legacy desktop app's start time",
    why: 'launching it would put a window on the screen',
  });
  notMeasured.push({
    what: 'throughput on real agents, either side',
    why: 'the echo driver measures the core, and a real multi agent run costs tokens on the user account',
  });
  if (raw.legacy.app !== null && !raw.legacy.app.found) {
    notMeasured.push({
      what: 'the live legacy app',
      why: 'no process was running at C:\\Users\\mtsu\\AppData\\Local\\Boite Legacy\\boite.exe',
    });
  }
}

const from = process.argv.indexOf('--from');
let raw: Raw;
let report: Report;

if (from >= 0) {
  const path = process.argv[from + 1];
  if (path === undefined) throw new Error('--from expects the path of a results json');
  const previous = JSON.parse(readFileSync(path, 'utf8')) as Report;
  raw = previous.raw as unknown as Raw;
  notMeasured.push(...previous.notMeasured.filter((entry) => entry.what.startsWith('claude.turn')));
  closingNotes(raw);
  report = { ...previous, rows: buildRows(raw), notMeasured };
} else {
  raw = await measure();
  closingNotes(raw);
  report = {
    date: today(),
    host: { platform: process.platform, arch: process.arch, cpus: cpus().length, bun: Bun.version },
    rows: buildRows(raw),
    raw: raw as unknown as Record<string, unknown>,
    notMeasured,
  };
}

const written = write(report, RESULTS);
process.stdout.write(`[bench] wrote ${written.json}\n[bench] wrote ${written.md}\n`);
