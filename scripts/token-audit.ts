/**
 * Where the context of Claude Code sessions goes, read from every `.jsonl`
 * transcript under `~/.claude/projects` changed in the last days. Every model
 * call re-reads its whole context, so a block costs its size times the calls
 * it stays for: the report ranks categories by that sum, then simulates a
 * lower compaction threshold, capped tool results and the clearing of old ones.
 *
 *   bun scripts/token-audit.ts [--days 7] [--root ~/.claude/projects] [--chars-per-token 2.5]
 *
 * The context of a call is the input, cache writes and cache reads of its
 * usage. The first call after a compaction gives the fixed prefix (system
 * prompt and tools) once the blocks it carries are taken away. Each later
 * call's growth goes to the previous answer up to its output tokens, thinking
 * being what its visible blocks leave, and the rest to the new tool results,
 * attachments and user text in proportion to their characters. An image
 * counts 1,500 tokens. The report prints the characters per token it
 * measured: pass that back with `--chars-per-token` when it differs.
 *
 * Sidechains are skipped and other agents' transcripts are not read. Price
 * units weigh tokens at API rates relative to input: cache read 0.1, 1 hour
 * write 2, 5 minute write 1.25, output 5.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const ROOT = opt('root', join(homedir(), '.claude', 'projects'));
const DAYS = Number(opt('days', '7'));
const CPT = Number(opt('chars-per-token', '2.5'));
const IMAGE_TOKENS = 1500;
const since = Date.now() - DAYS * 86_400_000;

type Live = Map<string, number>;
const weight = new Map<string, number>();     // category -> sum over calls of its tokens in context
const added = new Map<string, number>();      // category -> tokens added
const uses = new Map<string, number>();       // category -> blocks added
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

const calib = { tokens: 0, chars: 0 };
let calls = 0, sumCtx = 0, files = 0, segments = 0, compactions = 0, shrinks = 0, shrinkTokens = 0;
const usage = { read: 0, write5m: 0, write1h: 0, input: 0, output: 0 };
const postCompact: number[] = [];
const preCompact: number[] = [];
const summaries: number[] = [];      // characters of each compaction summary
const buckets = new Map<string, number>();    // ctx bucket -> sum ctx
const fanout = new Map<number, { calls: number; ctx: number }>();
const perProject = new Map<string, { calls: number; ctx: number; sessions: number }>();
// Per result block, for the cap and clearing simulations: tokens and calls it stayed for.
const results: { tool: string; tokens: number; stay: number }[] = [];
// Context sequence of each segment, for the compaction simulation.
const sequences: number[][] = [];

function bucket(ctx: number) {
  const k = Math.min(Math.floor(ctx / 50_000), 6) * 50;
  return k >= 300 ? '300k+' : `${k}-${k + 50}k`;
}

function shellKey(cmd: string): string {
  const b = /(?:^|[\s;&|("'])boite\s+([a-z-]+)(?:\s+([a-z-]+))?/.exec(cmd);
  if (b) return `boite ${b[1]}${b[1] === 'browser' || b[1] === 'delegate' || b[1] === 'threads' ? ` ${b[2] ?? ''}` : ''}`.trim();
  const c = cmd.trim().replace(/^(?:(?:cd|Set-Location)\s+[^;&\n]+(?:;|&&)\s*)+/i, '').replace(/^&\s*/, '');
  const first = /^["']?([^\s"']+)/.exec(c)?.[1] ?? '';
  const name = first.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();
  const sub = /^\S+\s+([a-z][\w:-]*)/i.exec(c)?.[1]?.toLowerCase();
  if (['git', 'gh', 'bun', 'npm', 'npx', 'cargo', 'dotnet', 'boite'].includes(name) && sub) return `${name} ${sub}`;
  return name || '(empty)';
}

function toolKey(name: string, input: any): string {
  if (name === 'Bash' || name === 'PowerShell') return `${name}: ${shellKey(String(input?.command ?? ''))}`;
  if (name === 'Read') {
    const path = String(input?.file_path ?? '');
    const ext = /\.[\w]+$/.exec(path)?.[0]?.toLowerCase() ?? '(none)';
    return `Read: ${ext} ${input?.offset != null || input?.limit != null ? 'part' : 'whole'}`;
  }
  if (name === 'Grep') return `Grep: ${input?.output_mode ?? 'files'}`;
  return name;
}

/** A user message's text by origin: Claude Code's reminders by kind, Boite's guide and notices, the rest the user's. */
function userTextParts(text: string): [string, number][] {
  const parts: [string, number][] = [];
  let rest = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, block => {
    let k = 'cc: reminder';
    if (/Contents of .*CLAUDE\.md|claudeMd|# claudeMd/.test(block)) k = 'cc: CLAUDE.md/AGENTS.md';
    else if (/skills are available|Skill tool/.test(block)) k = 'cc: skills list';
    else if (/deferred tools|ToolSearch/.test(block)) k = 'cc: deferred tools';
    else if (/gitStatus/.test(block)) k = 'cc: git status';
    else if (/todo|task list/i.test(block)) k = 'cc: todo nag';
    else if (/was modified|file .* changed/i.test(block)) k = 'cc: file changed';
    parts.push([k, block.length]);
    return '';
  });
  const cut = (marker: RegExp, k: string) => {
    const m = marker.exec(rest);
    if (!m) return;
    const end = rest.indexOf('\n\n', m.index + 1);
    const stop = end < 0 ? rest.length : end;
    parts.push([k, stop - m.index]);
    rest = rest.slice(0, m.index) + rest.slice(stop);
  };
  cut(/Answer style:/, 'boite: short answers');
  cut(/Boite coordination:/, 'boite: coordination guide');
  cut(/Boite subagents/, 'boite: delegation guide');
  cut(/\[Boite: the user sent/, 'boite: origin line');
  if (/^\s*\[?(Boite|boite)\b/.test(rest) || /<boite-|"from":\s*\{/.test(rest)) parts.push(['boite: message/notice', rest.length]);
  else if (rest.trim()) parts.push(['user: text', rest.length]);
  return parts;
}

type Pending = { cat: string; chars: number; image?: boolean; assistant?: boolean; tool?: string };

async function* lines(path: string) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of Bun.file(path).stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

function contentBlocks(content: any): any[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
}

async function auditFile(path: string, project: string) {
  const tools = new Map<string, string>();
  let live: Live = new Map();
  let pending: Pending[] = [];
  let lastCtx = 0, lastOut = 0, lastId = '', first = true, seq: number[] = [], lastAt = 0, sessionCtx = 0;
  // Open result blocks of this segment, so their stay can be counted.
  let open: { tool: string; tokens: number; from: number }[] = [];
  let segCalls = 0;
  const closeSegment = () => {
    for (const r of open) results.push({ tool: r.tool, tokens: r.tokens, stay: segCalls - r.from });
    if (seq.length) sequences.push(seq);
    open = []; seq = []; segCalls = 0; live = new Map(); first = true;
  };
  const p = perProject.get(project) ?? { calls: 0, ctx: 0, sessions: 0 };
  p.sessions++;
  perProject.set(project, p);

  for await (const line of lines(path)) {
    if (!line) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      if (!first) { compactions++; preCompact.push(lastCtx); }
      closeSegment();
      pending = [];
      sessionCtx = 0;
      continue;
    }
    // prompt_snapshot records the system prompt and deferred_tools_record is bookkeeping: neither is a message.
    if (e.type === 'attachment' && e.attachment && !['prompt_snapshot', 'deferred_tools_record'].includes(e.attachment.type)) {
      pending.push({ cat: `cc: attachment ${e.attachment.type ?? '?'}`, chars: JSON.stringify(e.attachment).length });
      continue;
    }
    if (e.type === 'user' && e.message) {
      if (e.isCompactSummary) {
        const chars = JSON.stringify(e.message.content).length;
        summaries.push(chars);
        pending.push({ cat: 'compaction summary', chars });
        continue;
      }
      for (const b of contentBlocks(e.message.content)) {
        if (b.type === 'text') for (const [k, n] of userTextParts(b.text ?? '')) pending.push({ cat: k, chars: n });
        else if (b.type === 'image') pending.push({ cat: 'user: image', chars: 0, image: true });
        else if (b.type === 'tool_result') {
          const tool = tools.get(b.tool_use_id) ?? '?';
          for (const c of contentBlocks(b.content)) {
            if (c.type === 'image') pending.push({ cat: `result ${tool}`, chars: 0, image: true, tool });
            else pending.push({ cat: `result ${tool}`, chars: String(c.text ?? '').length, tool });
          }
        }
      }
      continue;
    }
    if (e.type !== 'assistant' || !e.message) continue;
    const m = e.message;
    if (m.id !== lastId && m.usage && m.model !== '<synthetic>') {
      flushFanout();
      lastId = m.id;
      const u = m.usage;
      const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
      usage.read += u.cache_read_input_tokens ?? 0;
      usage.write1h += w1h;
      usage.write5m += w5m;
      usage.input += u.input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      const ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      cacheCalls(Date.parse(e.timestamp) || 0, lastAt, sessionCtx, ctx, u.cache_read_input_tokens ?? 0, (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0));
      lastAt = Date.parse(e.timestamp) || lastAt; sessionCtx = ctx;
      const est = (b: Pending) => b.image ? IMAGE_TOKENS : b.chars / CPT;
      if (first) {
        const known = pending.reduce((s, b) => s + est(b), 0);
        const scale = known > ctx ? ctx / known : 1;
        live.set('fixed prefix (system+tools)', Math.max(0, ctx - known));
        for (const b of pending) { add(live, b.cat, est(b) * scale); add(added, b.cat, est(b) * scale); add(uses, b.cat, 1); }
        first = false;
        segments++;
        postCompact.push(ctx);
      } else {
        const delta = ctx - lastCtx;
        if (delta < 0) {
          // Context shrank without a boundary: the CLI cleared something. Scale the history down.
          shrinks++; shrinkTokens -= delta;
          const hist = [...live].filter(([k]) => k !== 'fixed prefix (system+tools)').reduce((s, [, v]) => s + v, 0);
          const f = hist > 0 ? Math.max(0, (hist + delta) / hist) : 1;
          for (const [k, v] of live) if (k !== 'fixed prefix (system+tools)') live.set(k, v * f);
          for (const r of open) r.tokens *= f;
        }
        const growth = Math.max(0, delta);
        // The previous answer, thinking included, enters the context whole: its output_tokens.
        const asst = Math.min(growth, lastOut);
        const user = growth - asst;
        const mine = pending.filter(b => b.assistant), theirs = pending.filter(b => !b.assistant);
        const visible = mine.reduce((s, b) => s + est(b), 0);
        const vScale = visible > asst ? asst / visible : 1;
        const known = theirs.reduce((s, b) => s + est(b), 0);
        const uScale = known > 0 ? user / known : 0;
        if (known > 0) { calib.tokens += user; calib.chars += theirs.reduce((s, b) => s + (b.image ? 0 : b.chars), 0) + theirs.filter(b => b.image).length * IMAGE_TOKENS * CPT; }
        for (const b of mine) { const t = est(b) * vScale; add(live, b.cat, t); add(added, b.cat, t); add(uses, b.cat, 1); }
        add(live, 'assistant: thinking', asst - visible * vScale); add(added, 'assistant: thinking', asst - visible * vScale);
        for (const b of theirs) {
          const t = est(b) * uScale;
          add(live, b.cat, t); add(added, b.cat, t); add(uses, b.cat, 1);
          if (b.tool) open.push({ tool: b.cat, tokens: t, from: segCalls });
        }
        if (known === 0 && user > 0) { add(live, 'unexplained', user); add(added, 'unexplained', user); }
      }
      for (const [k, v] of live) add(weight, k, v);
      calls++; segCalls++; sumCtx += ctx; p.calls++; p.ctx += ctx; seq.push(ctx);
      add(buckets, bucket(ctx), ctx);
      lastCtx = ctx;
      lastOut = u.output_tokens ?? 0;
      pending = [];
      // A message's blocks can span several lines: later lines of the same id add their tool_use blocks.
      fanoutCall = { ctx, n: contentBlocks(m.content).filter(b => b.type === 'tool_use').length };
    } else if (m.id === lastId && fanoutCall) {
      fanoutCall.n += contentBlocks(m.content).filter(b => b.type === 'tool_use').length;
    }
    for (const b of contentBlocks(m.content)) {
      if (b.type === 'tool_use') {
        const key = toolKey(b.name, b.input);
        tools.set(b.id, key);
        pending.push({ cat: `call ${b.name}`, chars: JSON.stringify(b.input ?? {}).length, assistant: true });
      } else if (b.type === 'text') pending.push({ cat: 'assistant: text', chars: (b.text ?? '').length, assistant: true });
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') pending.push({ cat: 'assistant: thinking', chars: 0, assistant: true });
    }
  }
  flushFanout();
  closeSegment();
}

// Cache behaviour of each call: a miss writes what an earlier call already wrote.
const cache = { hits: 0, missIdle: 0, missWarm: 0, missWarmTokens: 0, missIdleTokens: 0, gap5to60: 0, gap5to60Ctx: 0, cost1h: 0, cost5m: 0 };
function cacheCalls(at: number, prevAt: number, prevCtx: number, ctx: number, read: number, write: number) {
  const gap = prevAt ? (at - prevAt) / 60_000 : Infinity;
  const actual = read * 0.1 + write * 2;
  cache.cost1h += actual;
  if (!prevCtx || gap === Infinity) { cache.cost5m += read * 0.1 + write * 1.25; return; }
  const expected = Math.max(0, ctx - prevCtx);
  const missed = read < prevCtx * 0.9;
  if (missed && gap < 60) { cache.missWarm++; cache.missWarmTokens += Math.max(0, write - expected); }
  else if (missed) { cache.missIdle++; cache.missIdleTokens += Math.max(0, write - expected); }
  else cache.hits++;
  if (gap > 5 && gap <= 60 && !missed) {
    // With a 5 minute lifetime this call would have written its whole context again.
    cache.gap5to60++; cache.gap5to60Ctx += ctx;
    cache.cost5m += ctx * 1.25;
  } else cache.cost5m += read * 0.1 + write * 1.25;
}
let fanoutCall: { ctx: number; n: number } | null = null;
function flushFanout() {
  if (!fanoutCall) return;
  const k = Math.min(fanoutCall.n, 4);
  const f = fanout.get(k) ?? { calls: 0, ctx: 0 };
  f.calls++; f.ctx += fanoutCall.ctx;
  fanout.set(k, f);
  fanoutCall = null;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (name.endsWith('.jsonl') && s.mtimeMs >= since) yield p;
  }
}

for (const path of walk(ROOT)) {
  const project = path.slice(ROOT.length + 1).split(/[\\/]/)[0]!;
  files++;
  try { await auditFile(path, project); } catch (err) { console.error(path, err); }
}

const M = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;
const cost = usage.read * 0.1 + usage.write5m * 1.25 + usage.write1h * 2 + usage.input + usage.output * 5;
console.log(`# Token audit, last ${DAYS} days (${new Date().toISOString().slice(0, 10)})`);
console.log(`files ${files}, segments ${segments}, compactions ${compactions}, calls ${calls}, sum of context ${M(sumCtx)}, mean ${Math.round(sumCtx / calls / 1000)}k`);
console.log(`measured chars per token of tool results and user text: ${(calib.chars / calib.tokens).toFixed(2)} (used ${CPT} for the first call)`);
console.log(`unbounded shrinks ${shrinks} (${M(shrinkTokens)} tokens dropped without a boundary)`);
console.log(`\n## Price units (input = 1): read ${pct(usage.read * 0.1, cost)}, write 1h ${pct(usage.write1h * 2, cost)}, write 5m ${pct(usage.write5m * 1.25, cost)}, uncached input ${pct(usage.input, cost)}, output x5 ${pct(usage.output * 5, cost)}  (raw: read ${M(usage.read)}, w1h ${M(usage.write1h)}, w5m ${M(usage.write5m)}, out ${M(usage.output)})`);

console.log('\n## Where the context goes (share of the sum of context over calls)');
console.log('| category | share | weight | added | blocks | mean calls stayed |\n|---|---|---|---|---|---|');
const totalW = [...weight.values()].reduce((a, b) => a + b, 0);
for (const [k, w] of [...weight].sort((a, b) => b[1] - a[1]).slice(0, 45))
  console.log(`| ${k} | ${pct(w, totalW)} | ${M(w)} | ${M(added.get(k) ?? 0)} | ${uses.get(k) ?? ''} | ${added.get(k) ? Math.round(w / added.get(k)!) : ''} |`);

console.log('\n## Grouped (results and calls by tool, Boite text, Claude Code text)');
const groups = new Map<string, number>();
for (const [k, w] of weight) add(groups, k.replace(/^(result|call) ([^:]+):.*$/, '$1 $2').replace(/^(cc|boite): .*$/, '$1: all'), w);
for (const [k, w] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`- ${k}: ${pct(w, totalW)}`);

console.log('\n## Sum of context by context size of the call');
for (const [k, v] of [...buckets].sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) console.log(`- ${k}: ${pct(v, sumCtx)}`);

console.log('\n## Calls by tool_use blocks in the answer');
for (const [k, v] of [...fanout].sort((a, b) => a[0] - b[0])) console.log(`- ${k === 4 ? '4+' : k}: ${v.calls} calls (${pct(v.calls, calls)}), ${pct(v.ctx, sumCtx)} of context`);

console.log(`\n## Cache: ${cache.hits} hits, ${cache.missWarm} misses within an hour of the previous call (${M(cache.missWarmTokens)} rewritten), ${cache.missIdle} after an idle hour (${M(cache.missIdleTokens)} rewritten)`);
console.log(`- calls 5-60 min after the previous one: ${cache.gap5to60} (${M(cache.gap5to60Ctx)} context the 1h lifetime kept)`);
console.log(`- input price units with the 1h lifetime: ${M(cache.cost1h)}; same calls with 5 min: ${M(cache.cost5m)} (${pct(cache.cost5m - cache.cost1h, cache.cost1h)})`);

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
console.log(`\n## Compaction: median context before ${Math.round(median(preCompact) / 1000)}k, median first call of a segment ${Math.round(median(postCompact) / 1000)}k, median summary ${median(summaries)} chars (~${(median(summaries) / CPT / 1000).toFixed(1)}k tokens)`);
const base = median(postCompact.filter((_, i) => i > 0)) || 30_000;
for (const T of [60_000, 80_000, 100_000, 120_000, 150_000, 200_000]) {
  let sim = 0, extra = 0, n = 0;
  for (const s of sequences) {
    let offset = 0;
    for (const c of s) {
      let v = c - offset;
      if (v > T) { offset += v - base; v = base; n++; extra += T; }
      sim += v;
    }
  }
  // A compaction reads the context, writes a summary (~8.3k output) and caches the new base past the shared ~15k prefix.
  const units = (sim + extra) * 0.1 + n * (8300 * 5 + Math.max(0, base - 15000) * 2);
  console.log(`- compact at ${T / 1000}k down to ${Math.round(base / 1000)}k: sum ${M(sim + extra)} (${pct(sim + extra - sumCtx, sumCtx)}), ${n} more compactions; read+compaction price units ${pct(units - sumCtx * 0.1, cost)} of all`);
}

console.log('\n## Tool results: cap simulation (tokens above the cap never enter context)');
for (const cap of [2000, 5000, 10000]) {
  let saved = 0;
  for (const r of results) if (r.tokens > cap) saved += (r.tokens - cap) * r.stay;
  console.log(`- cap ${cap}: saves ${M(saved)} (${pct(saved, sumCtx)})`);
}
console.log('\n## Tool results: clearing results older than K calls (results over 500 tokens, stub 40)');
for (const K of [5, 10, 20, 40]) {
  let saved = 0;
  for (const r of results) if (r.tokens > 500 && r.stay > K) saved += (r.tokens - 40) * (r.stay - K);
  console.log(`- K=${K}: saves ${M(saved)} (${pct(saved, sumCtx)})`);
}

console.log('\n## Top 15 projects by sum of context');
for (const [k, v] of [...perProject].sort((a, b) => b[1].ctx - a[1].ctx).slice(0, 15))
  console.log(`- ${k}: ${M(v.ctx)} (${pct(v.ctx, sumCtx)}), ${v.calls} calls, ${v.sessions} sessions`);
