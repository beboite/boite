import type { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';
import { gradeWide, type WideObservation } from './browser-wide-grade.ts';
import type { WideTask } from './browser-wide-tasks.ts';

type Action = 'snapshot' | 'inspect' | 'click' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'scroll';
type Command = { action: Action; selector?: string; value?: string; key?: string; direction?: 'up' | 'down'; amount?: number; query?: string };
type BrowserResult = Record<string, unknown>;

export const lunaBrowserTool = {
  name: 'browser',
  description: 'Use the current browser page. Inspect reveals page-derived selectors and options. Use snapshot query to search full page controls when output is truncated or a target is missing. Batch independent fills or checks using observed selectors. Navigation changes stop the batch. No direct URL navigation or script execution.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['commands'],
    properties: {
      commands: { type: 'array', minItems: 1, maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['action'], properties: {
          action: { type: 'string', enum: ['snapshot', 'inspect', 'click', 'fill', 'press', 'select', 'check', 'uncheck', 'scroll'] },
          selector: { type: 'string', description: 'A visible @eN reference from the latest snapshot, or an exact CSS selector returned by inspect.' },
          value: { type: 'string', description: 'For fill, a supplied task value. For select, an inspected option value or label.' },
          key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'Space'] },
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'integer', minimum: 1, maximum: 1200 },
          query: { type: 'string', minLength: 1, maxLength: 100, description: 'For snapshot only: case-insensitive text filter across the full native snapshot.' },
        },
      } },
    },
  },
} as const;

// Fixed, read-only DOM projection. It never receives model-supplied script or
// grader selectors. Each CSS selector is verified unique in the current page.
const inspectScript = (fieldsOnly: boolean) => `(()=>{
  const nodes=Array.from(document.querySelectorAll('${fieldsOnly ? 'input,textarea,select' : 'input,textarea,select,button,a[href],[role="button"],[role="combobox"],[role="checkbox"]'}'))
    .filter(e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden').slice(0,200);
  const esc=s=>CSS.escape(s);
  const unique=(s,e)=>{try{return document.querySelectorAll(s).length===1&&document.querySelector(s)===e}catch{return false}};
  const selector=e=>{
    if(e.id&&unique('#'+esc(e.id),e))return '#'+esc(e.id);
    const tag=e.tagName.toLowerCase(),name=e.getAttribute('name');
    if(name){const s=tag+'[name="'+CSS.escape(name)+'"]';if(unique(s,e))return s}
    const chain=[];let n=e;
    while(n&&n.nodeType===1&&chain.length<12){
      const t=n.tagName.toLowerCase();let s=t;
      if(n.id){s='#'+esc(n.id);chain.unshift(s);break}
      const siblings=Array.from(n.parentElement?.children??[]).filter(x=>x.tagName===n.tagName);
      if(siblings.length>1)s+=':nth-of-type('+(siblings.indexOf(n)+1)+')';
      chain.unshift(s);n=n.parentElement;
    }
    const s=chain.join(' > ');return unique(s,e)?s:null;
  };
  return nodes.map(e=>{
    const s=selector(e);if(!s)return null;
    const id=e.id,associated=id?document.querySelector('label[for="'+CSS.escape(id)+'"]'):null;
    const parentLabel=e.closest('label');
    const nearby=e.parentElement?.innerText?.trim().slice(0,120)??'';
    return {selector:s,tag:e.tagName.toLowerCase(),type:e.getAttribute('type')??undefined,
      id:id||undefined,name:e.getAttribute('name')??undefined,
      label:(associated?.textContent??parentLabel?.textContent??e.getAttribute('aria-label')??e.getAttribute('title')??'').trim().slice(0,120),
      text:(e.innerText??'').trim().slice(0,120),nearby,
      value:'value' in e?String(e.value).slice(0,120):undefined,
      checked:'checked' in e?Boolean(e.checked):undefined,
      options:e.tagName==='SELECT'?Array.from(e.options).slice(0,${fieldsOnly ? 30 : 100}).map(o=>({label:o.label.slice(0,100),value:o.value.slice(0,100)})):undefined};
  }).filter(Boolean)
})()`;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCommand(raw: unknown): Command {
  if (!object(raw) || typeof raw.action !== 'string') throw new Error('Browser command requires an action.');
  const action = raw.action;
  const fields: Record<Action, string[]> = {
    snapshot: ['query'], inspect: [], click: ['selector'], fill: ['selector', 'value'],
    press: ['key'], select: ['selector', 'value'], check: ['selector'], uncheck: ['selector'],
    scroll: ['direction', 'amount'],
  };
  if (!Object.hasOwn(fields, action)) throw new Error(`Browser action ${action} is unavailable.`);
  for (const key of Object.keys(raw)) if (key !== 'action' && !fields[action as Action]!.includes(key)) throw new Error(`Browser ${action}: unexpected field ${key}.`);
  if (['click', 'fill', 'select', 'check', 'uncheck'].includes(action) && (typeof raw.selector !== 'string' || !raw.selector.trim() || raw.selector.length > 500)) throw new Error(`${action}.selector must be a short observed selector.`);
  if (['fill', 'select'].includes(action) && (typeof raw.value !== 'string' || raw.value.length > 2000)) throw new Error(`${action}.value must be a string of at most 2000 characters.`);
  if (action === 'press' && !['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'Space'].includes(String(raw.key))) throw new Error('press.key is unavailable.');
  if (action === 'scroll' && (!['up', 'down'].includes(String(raw.direction)) || typeof raw.amount !== 'number' || !Number.isInteger(raw.amount) || raw.amount < 1 || raw.amount > 1200)) throw new Error('scroll requires direction up|down and amount 1..1200.');
  if (action === 'snapshot' && raw.query !== undefined && (typeof raw.query !== 'string' || !raw.query.trim() || raw.query.length > 100)) throw new Error('snapshot.query must be 1..100 nonblank characters.');
  return raw as Command;
}

export class LunaPage {
  readonly commands: { action: string; args: BrowserResult; ms: number; success: boolean; error?: string }[] = [];
  readonly attempts: { command: unknown; ms: number; success: boolean; error?: string }[] = [];
  readonly urls: string[] = [];
  actionCount: number;
  private refs = new Set<string>();
  private selectors = new Map<string, { tag: string; options?: { label: string; value: string }[] }>();
  private readonly origin: string;

  constructor(private readonly daemon: BrowserDaemon, private readonly task: WideTask, initialActions = 0, initialUrls: string[] = []) {
    if (!Number.isInteger(initialActions) || initialActions < 0 || initialActions > 30) throw new Error('initialActions must be 0..30.');
    this.actionCount = initialActions;
    this.origin = new URL(task.url).origin;
    for (const url of initialUrls) {
      if (new URL(url).origin !== this.origin) throw new Error('initialUrls must stay on the task origin.');
      if (this.urls.at(-1) !== url) this.urls.push(url);
    }
  }

  private async native(action: string, args: BrowserResult = {}): Promise<BrowserResult> {
    const start = performance.now();
    try {
      const result = await this.daemon.command(action, args);
      this.commands.push({ action, args, ms: performance.now() - start, success: true });
      return result;
    } catch (error) {
      this.commands.push({ action, args, ms: performance.now() - start, success: false, error: String(error) });
      throw error;
    }
  }

  private async pageState(): Promise<{ url: string; title: string; text: string }> {
    const raw = await this.native('evaluate', { script: '({url:location.href,title:document.title,text:document.body?.innerText??""})' });
    if (!object(raw.result) || typeof raw.result.url !== 'string' || typeof raw.result.title !== 'string' || typeof raw.result.text !== 'string') throw new Error('Browser returned invalid page state.');
    const state = raw.result as { url: string; title: string; text: string };
    if (this.urls.at(-1) !== state.url) this.urls.push(state.url);
    if (new URL(state.url).origin !== this.origin) throw new Error(`Navigation left the starting origin: ${state.url}`);
    return state;
  }

  async observe(query?: string) {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await this.pageState();
        const raw = await this.native('snapshot', { interactive: true, compact: true });
        if (typeof raw.snapshot !== 'string' || !object(raw.refs)) throw new Error('Browser returned no snapshot references.');
        const lines = raw.snapshot.split(/\r?\n/);
        if (lines.at(-1) === '') lines.pop();
        const matching = query ? lines.filter(line => line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : lines;
        const full = matching.join('\n');
        const clipped = full.length > 13_000;
        const snapshot = clipped ? full.slice(0, 13_000).replace(/\n[^\n]*$/, '') : full;
        const returnedLines = snapshot ? snapshot.split('\n').length : 0;
        this.refs = new Set([...snapshot.matchAll(/\bref=(e\d+)\b/g)].map(match => `@${match[1]}`).filter(ref => Object.hasOwn(raw.refs as object, ref.slice(1))));
        const fields = await this.fieldMetadata(true, 6_000);
        const latest = await this.pageState();
        if (latest.url !== state.url) {
          this.refs.clear(); this.selectors.clear();
          continue;
        }
        const text = state.text.slice(0, 4_000);
        return { url: state.url, title: state.title.slice(0, 500), text, snapshot, fields: fields.items,
          totalLines: lines.length, matchingLines: matching.length, returnedLines,
          truncated: state.text.length > text.length || clipped || fields.truncated, actionCount: this.actionCount };
      }
      throw new Error('Page URL changed during two consecutive observations.');
    } catch (error) {
      this.refs.clear(); this.selectors.clear();
      throw error;
    }
  }

  private async fieldMetadata(fieldsOnly: boolean, maxCharacters: number) {
    const raw = await this.native('evaluate', { script: inspectScript(fieldsOnly) });
    if (!Array.isArray(raw.result)) throw new Error('Browser returned invalid field metadata.');
    const fields = raw.result.filter(object).map(field => ({
      selector: field.selector, tag: field.tag, type: field.type, id: field.id, name: field.name,
      label: field.label, text: field.text, nearby: field.nearby, value: field.value,
      checked: field.checked, options: field.options,
    }));
    const selected: typeof fields = [];
    let length = 0;
    this.selectors.clear();
    for (const field of fields) {
      if (typeof field.selector !== 'string' || typeof field.tag !== 'string') continue;
      const row = JSON.stringify(field);
      if (length + row.length > maxCharacters) break;
      selected.push(field); length += row.length;
      this.selectors.set(field.selector, { tag: field.tag, options: Array.isArray(field.options) ? field.options.filter(object).filter(option => typeof option.value === 'string' && typeof option.label === 'string') as { label: string; value: string }[] : undefined });
    }
    return { items: selected, truncated: selected.length < fields.length };
  }

  private async inspect() {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await this.pageState();
        const fields = await this.fieldMetadata(false, 17_000);
        const latest = await this.pageState();
        if (latest.url !== state.url) {
          this.refs.clear(); this.selectors.clear();
          continue;
        }
        return { url: state.url, fields: fields.items, truncated: fields.truncated, actionCount: this.actionCount };
      }
      throw new Error('Page URL changed during two consecutive inspections.');
    } catch (error) {
      this.refs.clear(); this.selectors.clear();
      throw error;
    }
  }

  async execute(raw: unknown): Promise<unknown> {
    const started = performance.now();
    try {
      const result = await this.executeValidated(raw);
      this.attempts.push({ command: raw, ms: performance.now() - started, success: true });
      return result;
    } catch (error) {
      this.attempts.push({ command: raw, ms: performance.now() - started, success: false, error: String(error) });
      throw error;
    }
  }

  /** A batch uses only controls grounded before its first action. */
  async executeBatch(raw: unknown): Promise<{ results: { command: Command; success: boolean; error?: string }[]; observation?: unknown; error?: string }> {
    if (!object(raw) || Object.keys(raw).some(key => key !== 'commands') || !Array.isArray(raw.commands) || raw.commands.length < 1 || raw.commands.length > 8) {
      throw new Error('Browser batch requires 1..8 commands and no other fields.');
    }
    const commands = raw.commands.map(parseCommand);
    const previousUrl = this.urls.at(-1);
    const current = await this.pageState();
    const actions = commands.filter(command => command.action !== 'snapshot' && command.action !== 'inspect').length;
    if (previousUrl && current.url !== previousUrl) {
      this.refs.clear(); this.selectors.clear();
      if (actions > 0) throw new Error('Page URL changed before the batch. Refresh the observation.');
    }
    if (this.actionCount + actions > 30) throw new Error('Browser batch exceeds the 30 action limit.');
    for (const command of commands) {
      if (command.selector && !this.refs.has(command.selector) && !this.selectors.has(command.selector)) throw new Error('Batch selector was not observed on the current page.');
      if (command.action === 'fill' && !Object.values(this.task.values).includes(command.value!)) throw new Error('Batch fill value was not supplied in this task.');
      if (command.action === 'select') {
        const options = this.selectors.get(command.selector!)?.options;
        if (!options?.some(option => option.value === command.value || option.label === command.value)) throw new Error('Batch select value was not observed in this field.');
      }
    }
    const results: { command: Command; success: boolean; error?: string }[] = [];
    let observation: unknown;
    for (const command of commands) {
      try {
        observation = await this.execute(command);
        results.push({ command, success: true });
        if ((observation as { url?: unknown })?.url !== current.url && results.length < commands.length) {
          return { results, observation, error: 'Page URL changed during the batch. Refresh the observation before more actions.' };
        }
      } catch (error) {
        results.push({ command, success: false, error: String(error) });
        try { observation = await this.observe(); }
        catch (observationError) { return { results, error: `Could not observe the page after the failed command: ${String(observationError)}` }; }
        return { results, observation };
      }
    }
    return { results, observation };
  }

  private async executeValidated(raw: unknown): Promise<unknown> {
    const command = parseCommand(raw);
    if (command.action === 'snapshot') return this.observe(command.query);
    if (command.action === 'inspect') return this.inspect();
    await this.pageState();
    if (this.actionCount >= 30) throw new Error('Browser action limit of 30 reached.');
    if (command.selector) {
      if (!this.refs.has(command.selector) && !this.selectors.has(command.selector)) throw new Error('Selector was not observed on the current page. Refresh snapshot or inspect.');
      if (command.action === 'select') {
        const options = this.selectors.get(command.selector)?.options;
        if (!options || !options.some(option => option.value === command.value || option.label === command.value)) throw new Error('Select value was not observed in this field.');
      }
    }
    if (command.action === 'fill' && !Object.values(this.task.values).includes(command.value!)) throw new Error('Fill value was not supplied in this task.');
    const selectedValue = command.action === 'select' ? this.selectors.get(command.selector!)?.options?.find(option => option.value === command.value || option.label === command.value)?.value : undefined;
    this.actionCount++;
    this.refs.clear(); this.selectors.clear();
    const args: BrowserResult = { timeout: 5000 };
    if (command.selector) args.selector = command.selector;
    if (command.action === 'fill') args.value = command.value;
    if (command.action === 'select') args.values = selectedValue;
    if (command.action === 'press') args.key = command.key;
    if (command.action === 'scroll') { args.direction = command.direction; args.amount = command.amount; }
    try { await this.native(command.action, args); }
    catch (error) {
      await this.pageState();
      throw error;
    }
    return this.observe();
  }

  /** Called by the runner after the model stops. Grader data never enters model observations. */
  async finalEvidence() {
    const state = await this.pageState();
    const selectors = this.task.grader.all.flatMap(predicate => predicate.kind === 'control' ? [predicate.selector] : []);
    const raw = await this.native('evaluate', { script: `({url:location.href,title:document.title,text:document.body?.innerText??'',controls:Object.fromEntries(${JSON.stringify(selectors)}.map(s=>[s,Array.from(document.querySelectorAll(s)).map(e=>({value:e.value,checked:e.checked,expanded:e.getAttribute('aria-expanded')===null?undefined:e.getAttribute('aria-expanded')==='true'}))]))})` });
    if (!object(raw.result)) throw new Error('Browser returned invalid final evidence.');
    const final = raw.result as unknown as WideObservation;
    if (final.url !== state.url) await this.pageState();
    return { final, grading: gradeWide(this.task, final, this.urls, this.actionCount) };
  }
}
