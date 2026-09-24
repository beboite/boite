import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LabTask } from './browser-lab-tasks.ts';

type Engine = { command(action: string, args?: Record<string, unknown>): Promise<Record<string, any>> };
type Command = { action: string; selector?: string; value?: string; key?: string; query?: string; url?: string; tabId?: string; direction?: string; amount?: number; x?: number; y?: number; answer?: string };

export class LabInfrastructureError extends Error {
  constructor(message: string, readonly invalidatesCampaign = true) { super(message); }
}

export function labTool(vision: boolean) {
  return {
    type: 'function', name: 'browser',
    description: `Operate the real browser. Every result includes fresh state; refs are from the latest snapshot. observe(query) searches longer snapshots and text. open/tab_new only accept exact URLs observed in links or tabs. Batch at most four grounded actions; errors stop a batch. ${vision ? 'Screenshots are provided; coordinate click is available for visible controls that lack useful refs.' : 'This arm provides text observations only.'} finish records your answer; it does not determine benchmark success.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['commands'], properties: {
      commands: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['observe', 'click', 'fill', 'press', 'select', 'check', 'uncheck', 'scroll', 'open', 'tab_new', 'tab_switch', 'back', 'download', 'finish', ...(vision ? ['click_xy'] : [])] },
        selector: { type: 'string', description: 'Exact @ref from the current snapshot.' },
        value: { type: 'string' }, key: { type: 'string' }, query: { type: 'string' },
        url: { type: 'string', description: 'Exact page-derived URL from observed links/tabs.' }, tabId: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1, maximum: 1200 },
        x: { type: 'number', minimum: 0, maximum: 1279 }, y: { type: 'number', minimum: 0, maximum: 799 },
        answer: { type: 'string', description: 'For finish: requested extracted facts, URLs, and any unmet requirements.' },
      } } },
    } },
  };
}

// Evidence is collected independently of model text, including open shadow roots.
export const labStateScript = String.raw`(()=>{
 const roots=[document];const walk=r=>{for(const e of r.querySelectorAll('*'))if(e.shadowRoot){roots.push(e.shadowRoot);walk(e.shadowRoot)}};walk(document);
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const links=roots.flatMap(r=>Array.from(r.querySelectorAll('a[href]'))).filter(visible).map(e=>({text:(e.innerText||e.getAttribute('aria-label')||e.title||'').trim().slice(0,160),url:e.href}));
 const text=roots.map(r=>r===document?document.body?.innerText??'':Array.from(r.children).filter(e=>!['STYLE','SCRIPT','TEMPLATE'].includes(e.tagName)&&visible(e)).map(e=>e.innerText??'').join('\n')).join('\n');
 const dialogs=roots.flatMap(r=>Array.from(r.querySelectorAll('[role="dialog"],dialog,[aria-modal="true"]'))).filter(visible).map(e=>(e.innerText||'').slice(0,4000));
 return {url:location.href,title:document.title,text,links,dialogs,viewport:{width:innerWidth,height:innerHeight},darkMode:matchMedia('(prefers-color-scheme: dark)').matches};
})()`;

export class LabPage {
  readonly history: any[] = [];
  readonly attempts: any[] = [];
  readonly visited: string[] = [];
  answer = '';
  finished = false;
  actionCount = 0;
  private refs = new Set<string>();
  private urls = new Set<string>();
  private tabs = new Set<string>();
  private sequence = 0;
  constructor(private engine: Engine, readonly task: LabTask, readonly vision: boolean, readonly directory: string, private deadline: number, private maxActions = 60) {
    mkdirSync(directory, { recursive: true });
    this.urls.add(task.url);
  }
  private allowed(raw: string) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !this.task.hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('URL outside the task domains.');
    return url.href;
  }
  async observe(query?: string) {
    const at = performance.now();
    await this.engine.command('prepare_observation');
    const errors: string[] = [];
    let state: any = {}, snapshot: any = {}, tabs: any = {};
    try { state = (await this.engine.command('evaluate', { script: labStateScript })).result ?? {}; }
    catch (error) { errors.push('state: ' + String(error)); }
    if (state.url) { this.allowed(state.url); if (this.visited.at(-1) !== state.url) this.visited.push(state.url); }
    try { snapshot = await this.engine.command('snapshot', { interactive: false, compact: true }); }
    catch (error) { errors.push('snapshot: ' + String(error)); }
    try { tabs = await this.engine.command('tabs'); }
    catch (error) { errors.push('tabs: ' + String(error)); }
    const tabRows = Array.isArray(tabs.tabs) ? tabs.tabs : [];
    this.tabs = new Set(tabRows.map((tab: any) => String(tab.tabId ?? tab.id ?? tab.index)));
    for (const tab of tabRows) if (tab.url) { try { this.urls.add(this.allowed(tab.url)); } catch {} }
    this.refs.clear();
    const raw = String(snapshot.snapshot ?? '');
    const lines = raw.split('\n');
    const matches = (line: string) => !query || query.toLowerCase().split(/\s+/).every(word => line.toLowerCase().includes(word));
    const selected = query ? lines.filter(matches) : lines;
    const shown = selected.join('\n').slice(0, 18000);
    for (const attributes of shown.matchAll(/\[([^\]]+)\]/g)) {
      const ref = attributes[1]!.match(/(?:^|[\s,])ref=((?:f\d+)?e\d+)(?=$|[\s,])/);
      if (ref) this.refs.add('@' + ref[1]);
    }
    for (const match of shown.matchAll(/@(e\d+|[a-z]\d+e\d+)\b/g)) this.refs.add('@' + match[1]);
    const linkRows = (state.links ?? []).filter((link: any) => matches(link.text + ' ' + link.url)).slice(0, 65);
    for (const link of linkRows) { try { this.urls.add(this.allowed(link.url)); } catch {} }
    const text = String(state.text ?? '');
    const shownText = query ? text.split('\n').filter(matches).join('\n').slice(0, 9000) : text.slice(0, 9000);
    const id = ++this.sequence;
    const path = join(this.directory, String(id).padStart(3, '0') + '.png');
    let imageUrl: string | undefined;
    let dimensions: { width: number; height: number } | undefined;
    try {
      await this.engine.command('screenshot', { path });
      const png = readFileSync(path);
      if (png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      if (this.vision) imageUrl = 'data:image/png;base64,' + png.toString('base64');
    }
    catch (error) { errors.push('screenshot: ' + String(error)); }
    const evidence = { id, atMs: performance.now(), state, snapshot, tabs, screenshot: path, dimensions, errors, observationMs: performance.now() - at };
    this.history.push(evidence);
    writeFileSync(join(this.directory, String(id).padStart(3, '0') + '.json'), JSON.stringify(evidence, null, 2));
    if ((state.viewport && (state.viewport.width !== 1280 || state.viewport.height !== 800)) || (dimensions && (dimensions.width !== 1280 || dimensions.height !== 800)) || state.darkMode === true) {
      this.refs.clear();
      throw new LabInfrastructureError('Rendering differs from 1280x800 light theme; evidence saved. A fresh valid observation is required before acting.', id === 1);
    }
    return { text: { url: state.url, title: state.title, snapshot: shown, truncated: shown.length < raw.length, pageText: shownText, links: linkRows, dialogs: state.dialogs, tabs, errors, actionCount: this.actionCount, remainingSeconds: Math.max(0, Math.round((this.deadline - performance.now()) / 1000)) }, imageUrl };
  }
  async execute(raw: unknown) {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).commands)) throw new Error('commands array required.');
    const commands = (raw as any).commands as Command[];
    if (commands.length < 1 || commands.length > 4) throw new Error('Use one to four commands.');
    const results: any[] = [];
    let query: string | undefined;
    for (const c of commands) {
      if (performance.now() >= this.deadline || this.finished) break;
      const at = performance.now();
      try {
        if (c.selector && /^(?:@|ref=|\[ref=)?(?:f\d+)?e\d+\]?$/.test(c.selector)) c.selector = '@' + c.selector.replace(/^(?:@|ref=|\[ref=)/, '').replace(/\]$/, '');
        if (c.action === 'finish') { this.answer = String(c.answer ?? ''); this.finished = true; results.push({ action: 'finish', recorded: true }); break; }
        if (c.action === 'observe') { query = c.query; continue; }
        if (++this.actionCount > this.maxActions) throw new Error('Action budget exhausted. Stop with the unmet requirements.');
        if (['click', 'fill', 'select', 'check', 'uncheck', 'download'].includes(c.action) && (!c.selector || !this.refs.has(c.selector))) throw new Error('selector must be a ref in the latest observation; observe again.');
        let result: any;
        if (['open', 'tab_new'].includes(c.action)) {
          if (!c.url || !this.urls.has(this.allowed(c.url))) throw new Error('Use an exact URL from observed links or tabs.');
          result = await this.engine.command(c.action === 'open' ? 'navigate' : 'tab_new', { url: c.url, waitUntil: 'domcontentloaded' });
        } else if (c.action === 'tab_switch') {
          if (!c.tabId || !this.tabs.has(c.tabId)) throw new Error('Use a tabId from observed tabs.');
          result = await this.engine.command('tab_switch', { tabId: c.tabId });
        } else if (c.action === 'click_xy') {
          if (!this.vision || typeof c.x !== 'number' || typeof c.y !== 'number' || c.x < 0 || c.x >= 1280 || c.y < 0 || c.y >= 800) throw new Error('Coordinates require the vision arm and current viewport.');
          await this.engine.command('mouse', { eventType: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
          result = await this.engine.command('mouse', { eventType: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
        } else if (c.action === 'download') {
          result = await this.engine.command('download', { selector: c.selector, path: join(this.directory, 'download.zip') });
        } else if (['click', 'fill', 'press', 'select', 'check', 'uncheck', 'scroll', 'back'].includes(c.action)) {
          const { action, ...args } = c;
          result = await this.engine.command(action, args);
        } else throw new Error('Unknown action: ' + c.action);
        const record = { command: c, result, ms: performance.now() - at, success: true };
        this.attempts.push(record); results.push(record);
      } catch (error) {
        const record = { command: c, error: String(error), ms: performance.now() - at, success: false };
        this.attempts.push(record); results.push(record); break;
      }
    }
    const observation = await this.observe(query);
    return { contentItems: [{ type: 'inputText', text: JSON.stringify({ results, ...observation.text, finished: this.finished }) }, ...(observation.imageUrl ? [{ type: 'inputImage', imageUrl: observation.imageUrl }] : [])], success: true };
  }
}
