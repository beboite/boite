/** How long the Agents page takes to show its agents and the conversation it opens, first visit and
 * return visit, in the production UI on a temporary core, behind an emulated remote link.
 * An agent's conversation is its thread: a desktop visit opens the agent shown last, its header and
 * its messages drawn by the ordinary chat view.
 * Run: bun run build:ui && bun run bench/agents-page.ts [--ui <dist>] [--latency 40] [--kbps 4000] [--runs 5]
 */
import { connect } from '../packages/core/src/client.ts';
import { BrowserPage } from '../tests/e2e/lib/cdp.ts';
import { pairingUrlOf, startCore } from '../tests/e2e/lib/core.ts';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
};
const ui = arg('ui', '');
const latency = Number(arg('latency', '40'));
const kbps = Number(arg('kbps', '4000'));
const runs = Number(arg('runs', '5'));
const AGENTS = 12;

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
/** `ms`: the first agent row; `chatAt`: the opened agent's header and a message of its thread. */
type Visit = { ms: number; pageAt: number; chatAt: number; chunkEnd: number | null };
const first: Visit[] = [], again: Visit[] = [];

for (let run = 0; run < runs; run++) {
  const core = await startCore(ui ? { env: { BOITE_UI_DIR: ui } } : {});
  let page: BrowserPage | undefined;
  try {
    const client = await connect(core.url, core.token);
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    for (let i = 0; i < AGENTS; i++) {
      await client.call('agents.profile.save', { value: { name: `Agent ${i}`, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', projectIds: [] } });
    }
    // Each new agent introduces itself in its thread; the visit is measured once they all rest.
    for (let tries = 0; ; tries++) {
      const { status } = await client.call('agents.snapshot', {});
      if (status.length === AGENTS && status.every(s => s.state === 'idle' && s.last !== null)) break;
      if (tries > 300) throw new Error(`the agents did not rest: ${JSON.stringify(status.map(s => s.state))}`);
      await Bun.sleep(100);
    }
    client.close();
    page = await BrowserPage.launch({ url: pairingUrlOf(core), experiments: ['resident-agents'], windowSize: { width: 1440, height: 900 } });
    await page.send('Network.enable', {});
    await page.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: (kbps * 1000) / 8, uploadThroughput: (kbps * 1000) / 8 });
    await page.waitFor(`document.querySelector('[data-testid=status-connection]')?.dataset.state === 'ready'`, 30_000);
    await page.waitFor(`document.querySelector('[data-testid$=view-agents]')`, 30_000);
    // Long enough for an idle prefetch to have run, as for someone reading a thread first.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const visit = async () => JSON.parse(await page!.evaluate<string>(`new Promise(resolve => {
      const start = performance.now();
      document.querySelector('[data-testid$=view-agents]').click();
      let pageAt = 0, rowAt = 0;
      const check = () => {
        const now = performance.now() - start;
        if (!pageAt && document.querySelector('[data-testid=agents-page]')) pageAt = now;
        if (!rowAt && document.querySelector('[data-testid^="agent-entry-"]')) rowAt = now;
        if (rowAt && document.querySelector('.agents-main [data-testid=agent-header]') && document.querySelector('.agents-main [data-testid=message]')) {
          const chunk = performance.getEntriesByType('resource').find(e => /AgentsPage/.test(e.name));
          resolve(JSON.stringify({ ms: rowAt, pageAt, chatAt: now, chunkEnd: chunk && chunk.responseEnd >= start ? chunk.responseEnd - start : null }));
        } else if (now > 20000) resolve(JSON.stringify({ ms: rowAt || now, pageAt, chatAt: now, chunkEnd: null, timedOut: true }));
        else requestAnimationFrame(check);
      };
      check();
    })`));
    first.push(await visit());
    await page.click('[data-testid$=view-threads]');
    await page.waitFor(`!document.querySelector('[data-testid=agents-page]') && document.querySelector('[data-testid$=view-agents]')`);
    await new Promise(resolve => setTimeout(resolve, 500));
    again.push(await visit());
  } finally {
    await page?.close();
    await core.stop();
  }
}
const round = (visits: Visit[]) => visits.map(v => ({ ms: Math.round(v.ms), pageAt: Math.round(v.pageAt), chatAt: Math.round(v.chatAt), chunkEnd: v.chunkEnd === null ? null : Math.round(v.chunkEnd) }));
console.log(JSON.stringify({
  ui: ui || 'packages/ui/dist', latencyMs: latency, kbps, runs, agents: AGENTS,
  firstMedianMs: Math.round(median(first.map(v => v.ms))), returnMedianMs: Math.round(median(again.map(v => v.ms))),
  firstChatMedianMs: Math.round(median(first.map(v => v.chatAt))), returnChatMedianMs: Math.round(median(again.map(v => v.chatAt))),
  first: round(first), again: round(again),
}));
