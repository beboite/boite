/** How long the Agents page takes to show its conversations, first visit and return visit,
 * in the production UI on a temporary core, behind an emulated remote link.
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

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
type Visit = { ms: number; pageAt: number; chunkEnd: number | null };
const first: Visit[] = [], again: Visit[] = [];

for (let run = 0; run < runs; run++) {
  const core = await startCore(ui ? { env: { BOITE_UI_DIR: ui } } : {});
  let page: BrowserPage | undefined;
  try {
    const client = await connect(core.url, core.token);
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    for (let i = 0; i < 12; i++) {
      await client.call('agents.profile.save', { value: { name: `Agent ${i}`, domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages', 'memory'] } });
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
      let pageAt = 0;
      const check = () => {
        if (!pageAt && document.querySelector('[data-testid=agents-page]')) pageAt = performance.now() - start;
        if (document.querySelector('[data-testid^="agent-entry-"]')) {
          const chunk = performance.getEntriesByType('resource').find(e => /AgentsPage/.test(e.name));
          resolve(JSON.stringify({ ms: performance.now() - start, pageAt, chunkEnd: chunk && chunk.responseEnd >= start ? chunk.responseEnd - start : null }));
        } else requestAnimationFrame(check);
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
const round = (visits: Visit[]) => visits.map(v => ({ ms: Math.round(v.ms), pageAt: Math.round(v.pageAt), chunkEnd: v.chunkEnd === null ? null : Math.round(v.chunkEnd) }));
console.log(JSON.stringify({ ui: ui || 'packages/ui/dist', latencyMs: latency, kbps, runs, firstMedianMs: Math.round(median(first.map(v => v.ms))), returnMedianMs: Math.round(median(again.map(v => v.ms))), first: round(first), again: round(again) }));
