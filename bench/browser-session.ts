import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startTestCore } from '../packages/core/test/harness.ts';
import { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { tasks } from './browser-real.ts';

// Subscription-driven benchmark. No model requests, credentials or user profiles.
if (!process.env.BOITE_BENCH_SESSION_OUTPUT || !process.env.BOITE_BROWSER_TEST_BINARY) throw new Error('Required: BOITE_BENCH_SESSION_OUTPUT and BOITE_BROWSER_TEST_BINARY.');
const output = resolve(process.env.BOITE_BENCH_SESSION_OUTPUT);
const binary = process.env.BOITE_BROWSER_TEST_BINARY;
const executable = findBrowser();
mkdirSync(output, { recursive: true });
const harness = await startTestCore();
const token = randomBytes(32).toString('hex');
type Command = { action: string; [key: string]: unknown };
type Session = { daemon: BrowserDaemon; arm: 'visual' | 'classic'; task: typeof tasks[number]; run: number; prefix: string; start: number; executionStart: number; startupMs: number; logs: any[]; urls: string[]; calls: number; actions: number; shots: number; id: string };
let session: Session | null = null;
let busy = false;
let ownsControl = false;

async function command(s: Session, action: string, args: Record<string, unknown>, phase: string) {
  const start = performance.now();
  try {
    const result = await s.daemon.command(action, args);
    s.logs.push({ phase, action, args, ms: performance.now() - start, atMs: start - s.start, success: true, ...(action === 'snapshot' ? { result } : {}) });
    return result;
  } catch (error) {
    s.logs.push({ phase, action, args, ms: performance.now() - start, atMs: start - s.start, success: false, error: String(error) });
    throw error;
  }
}
function observation(raw: Record<string, unknown>) {
  const { lifecycle, refs, ...result } = raw;
  if (typeof result.snapshot === 'string' && result.snapshot.length > 12_000) {
    result.snapshot = result.snapshot.slice(0, 12_000).replace(/\n[^\n]*$/, '');
    result.truncated = true;
  }
  return result;
}
async function recordUrl(s: Session) {
  const raw = await command(s, 'evaluate', { script: 'location.href' }, 'grader-observation');
  const url = String(raw.result);
  if (s.urls.at(-1) !== url) s.urls.push(url);
}
async function screenshot(s: Session, final = false) {
  const path = join(output, `${s.prefix}-${final ? 'final' : `shot-${++s.shots}`}.png`);
  await command(s, 'screenshot', { path }, final ? 'grader' : 'observation');
  return path;
}
const shared: Record<string, string[]> = {
  screenshot: [], press: ['key'], keyboard: ['subaction', 'text'],
  mouse: ['eventType', 'x', 'y', 'button', 'clickCount'],
  scroll: ['direction', 'amount', 'x', 'y'], wait: ['timeout'],
};
const classic: Record<string, string[]> = {
  snapshot: ['interactive', 'compact', 'maxDepth', 'selector'], click: ['selector'], fill: ['selector', 'value'],
  type: ['selector', 'text', 'clear'], hover: ['selector'], scrollintoview: ['selector'], evaluate: ['script'],
};
function validate(s: Session, item: Command) {
  if (!item || typeof item.action !== 'string') throw new Error('Each command requires action.');
  const fields = shared[item.action] ?? (s.arm === 'classic' ? classic[item.action] : undefined);
  if (!fields) throw new Error(`${s.arm}: action ${item.action} is unavailable.`);
  for (const key of Object.keys(item)) if (key !== 'action' && !fields.includes(key)) throw new Error(`${item.action}: unexpected field ${key}.`);
  if (item.action === 'evaluate' && !['location.href', 'document.title', 'document.body.innerText', '({url:location.href,title:document.title,text:document.body.innerText})'].includes(String(item.script))) throw new Error('evaluate accepts only the documented read-only expressions.');
  if (item.action === 'wait' && (typeof item.timeout !== 'number' || item.timeout < 0 || item.timeout > 2000)) throw new Error('wait.timeout must be 0..2000 milliseconds.');
  if (item.action === 'keyboard' && !['type', 'insertText'].includes(String(item.subaction))) throw new Error('keyboard.subaction must be type or insertText.');
  if (item.action === 'mouse' && !['mouseMoved', 'mousePressed', 'mouseReleased'].includes(String(item.eventType))) throw new Error('mouse.eventType must be mouseMoved, mousePressed or mouseReleased.');
}

async function start(body: any) {
  if (session) throw new Error('Finish the active task first.');
  const task = tasks.find(t => t.id === body.task);
  if (!task || !['visual', 'classic'].includes(body.arm) || !Number.isInteger(body.run) || body.run < 1) throw new Error('Expected arm visual|classic, task wikipedia|github|govuk, positive integer run.');
  const prefix = `${body.arm}-${task.id}-${body.run}`;
  if (existsSync(join(output, `${prefix}.json`))) throw new Error('This run already has a result; choose another run.');
  const start = performance.now();
  const id = `benchmark-${prefix}-${Date.now()}`;
  let daemon: BrowserDaemon;
  try { daemon = await BrowserDaemon.launch(harness.core, id, binary, executable, new AbortController().signal); }
  catch (error) {
    writeFileSync(join(output, `${prefix}.json`), JSON.stringify({ arm: body.arm, task: task.id, run: body.run, verified: false, startupError: String(error), startupMs: performance.now() - start }, null, 2));
    throw error;
  }
  const s: Session = { daemon, arm: body.arm, task, run: body.run, prefix, start, executionStart: 0, startupMs: 0, logs: [], urls: [], calls: 0, actions: 0, shots: 0, id };
  session = s;
  try {
    await command(s, 'viewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, 'startup');
    await command(s, 'navigate', { url: task.url, waitUntil: 'load' }, 'startup');
    s.startupMs = performance.now() - start;
    s.executionStart = performance.now();
    await recordUrl(s);
    return { arm: s.arm, task: task.id, run: s.run, goal: task.goal, values: task.values, startupMs: s.startupMs,
      ...(s.arm === 'visual' ? { screenshot: await screenshot(s) } : { observation: observation(await command(s, 'snapshot', { interactive: true, compact: true }, 'observation')) }) };
  } catch (error) {
    await daemon.close(); session = null;
    writeFileSync(join(output, `${prefix}.json`), JSON.stringify({ arm: body.arm, task: task.id, run: body.run, verified: false, startupError: String(error), startupMs: performance.now() - start, commands: s.logs }, null, 2));
    throw error;
  }
}
async function commands(body: any) {
  const s = session;
  if (!s) throw new Error('Start a task first.');
  if (performance.now() - s.executionStart >= 120_000) return { expired: true, ...await finish({ note: '120 second execution limit' }) };
  if (!Array.isArray(body.commands) || body.commands.length < 1 || body.commands.length > 30) throw new Error('commands must contain 1..30 entries.');
  for (const item of body.commands) validate(s, item);
  s.calls++;
  const results = [];
  for (const item of body.commands as Command[]) {
    if (performance.now() - s.executionStart >= 120_000) return { results, expired: true, ...await finish({ note: '120 second execution limit' }) };
    const { action, ...args } = item;
    const meaningful = !['snapshot', 'screenshot', 'evaluate', 'wait'].includes(action) && (action !== 'mouse' || args.eventType === 'mousePressed');
    if (meaningful && s.actions >= 30) return { results, limited: true, ...await finish({ note: '30 action limit' }) };
    if (meaningful) s.actions++;
    try {
      results.push({ action, ...(action === 'screenshot' ? { path: await screenshot(s) } : observation(await command(s, action, args, 'agent'))) });
      await recordUrl(s);
    } catch (error) { results.push({ action, error: String(error) }); break; }
  }
  return { results, ...(s.arm === 'visual' ? { screenshot: await screenshot(s) } : {}) };
}
async function finish(body: any) {
  const s = session;
  if (!s) throw new Error('Start a task first.');
  const executionMs = performance.now() - s.executionStart;
  let result: any = { arm: s.arm, task: s.task.id, run: s.run, date: new Date().toISOString(), goal: s.task.goal, startupMs: s.startupMs, executionMs,
    agentToolCalls: s.calls, actionCommands: s.actions, nativeAgentCommands: s.logs.filter(l => ['agent', 'observation'].includes(l.phase)).length,
    note: typeof body.note === 'string' ? body.note : '', verified: false, browser: executable, viewport: { width: 1280, height: 800 }, transport: 'Unmodified agent-browser 0.37.1 native daemon JSONL; CLI parser bypassed.' };
  try {
    await recordUrl(s);
    const raw = await command(s, 'evaluate', { script: '({url:location.href,title:document.title,text:document.body?.innerText??""})' }, 'grader');
    result.final = raw.result;
    result.urlMatches = result.final?.url === s.task.completion.url;
    result.textMatches = typeof result.final?.text === 'string' && result.final.text.includes(s.task.completion.text);
    result.govukSearchUsed = s.task.id !== 'govuk' || s.urls.some(url => { const u = new URL(url); return u.origin === 'https://www.gov.uk' && u.pathname.startsWith('/search/') && u.searchParams.get('keywords') === 'renew adult passport'; });
    result.withinLimits = executionMs < 120_000 && s.actions <= 30;
    result.verified = result.urlMatches && result.textMatches && result.govukSearchUsed && result.withinLimits;
    result.screenshot = await screenshot(s, true);
  } catch (error) { result.evidenceError = String(error); }
  finally {
    const cleanupStart = performance.now();
    try { await s.daemon.close(); }
    catch (error) { result.cleanupError = String(error); result.verified = false; }
    result.cleanupMs = performance.now() - cleanupStart;
    result.processesAfter = harness.core.procs.liveCount(`browser:${s.id}`);
    result.wallMs = performance.now() - s.start;
    result.commands = s.logs;
    result.urls = s.urls;
    const path = join(output, `${s.prefix}.json`);
    try { writeFileSync(path, JSON.stringify(result, null, 2)); }
    finally { session = null; }
    result.resultPath = path;
  }
  return { resultPath: result.resultPath, verified: result.verified, startupMs: result.startupMs, executionMs, wallMs: result.wallMs, agentToolCalls: result.agentToolCalls, actionCommands: result.actionCommands, processesAfter: result.processesAfter, screenshot: result.screenshot };
}
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 120, async fetch(request) {
  if (request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405 });
  if (busy) return Response.json({ error: 'A command is already running.' }, { status: 409 });
  busy = true;
  try {
    const body = await request.json();
    const path = new URL(request.url).pathname;
    if (path === '/start') return Response.json(await start(body));
    if (path === '/command') return Response.json(await commands(body));
    if (path === '/finish') return Response.json(await finish(body));
    if (path === '/status') return Response.json({ active: session ? { arm: session.arm, task: session.task.id, run: session.run } : null });
    if (path === '/shutdown') {
      if (session) await finish({ note: 'Service shutdown' });
      clearInterval(heartbeat);
      await harness.stop();
      if (ownsControl) { rmSync(control, { force: true }); ownsControl = false; }
      setTimeout(() => { server.stop(true); process.exit(0); }, 100);
      return Response.json({ shutdown: true });
    }
    return Response.json({ error: 'Unknown endpoint' }, { status: 404 });
  } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  finally { busy = false; }
} });
// The shipped daemon expires at 30 seconds. Neutral keepalive sends no page data
// to the agent, and its overhead is recorded separately from agent actions.
const heartbeat = setInterval(async () => {
  if (busy || !session) return;
  busy = true;
  try {
    if (performance.now() - session.executionStart >= 120_000) await finish({ note: '120 second execution limit' });
    else await command(session, 'evaluate', { script: '0' }, 'keepalive');
  } catch {} finally { busy = false; }
}, 10_000);
const control = join(output, 'control.json');
try {
  // Windows inherits directory ACLs, as the core's own token file does.
  writeFileSync(control, JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token, pid: process.pid, output }, null, 2), { mode: 0o600, flag: 'wx' });
  ownsControl = true;
  writeFileSync(join(output, 'metadata.json'), JSON.stringify({ pid: process.pid, output, binary, executable, viewport: { width: 1280, height: 800 }, controlFile: control, agentBrowserVersion: '0.37.1' }, null, 2));
} catch (error) {
  clearInterval(heartbeat);
  server.stop(true);
  try { await harness.stop(); }
  finally { if (ownsControl) rmSync(control, { force: true }); }
  throw error;
}
console.log(`READY controlFile=${control} metadata=${join(output, 'metadata.json')}`);
