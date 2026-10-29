import { newMobileThread } from './lib/mobile.ts';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attachment, RpcParams, RpcResult } from '../../packages/contracts/src/index.ts';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { freshDataDir, pairingUrlOf, startCore } from './lib/core.ts';
import { ensureProductionUi, UI_DIST } from './lib/prod-ui.ts';

const artifacts = join(import.meta.dir, '.artifacts');
const fileBytes = Buffer.from([0, 1, 2, 255, 128, 13, 10, ...Buffer.from('startup attachment integrity')]);
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAPAAAAB4CAIAAABD1OhwAAABkUlEQVR4nO3SQREBYBSAQZmEkEMCmaTQQQUjg4uLo4sADszP93ZmI+xmuzv8vtv9Ae/YLM8qNB8kNClCkyI0KUKTIjQpQpMiNClCkyI0KUKTIjQpQpMiNClCkyI0KUKTIjQpQpMiNCkjQu+PV/6I0EKnCC10itBCpwgtdIrQQqcILXSK0EKnCC10itBCpwgtdIrQQqcILXSK0EKnCC10itBCpwgtdIrQQqcILXSK0EKnCC10itBCpwgtdIrQQqcILXSK0EKnCC10itDwIjQpQpMiNClCkyI0KUKTIjQpQpMiNClCkyI0KUKTIjQpQpMiNClCkyI0KSNCn84Xvm15ZaERWmiEFnqC5ZWFRmihEVroCZZXFhqhhUZooSdYXllohBYaoYWeYHnlQaGZQ2hShCZFaFKEJkVoUoQmRWhShCZFaFKEJkVoUoQmRWhShCZFaFKEJkVoUoQmRWhShCZFaFKEJkVoUoQmRWhShCZFaFKEJkVoUoQmRWhShCZFaFKEJkVoUoQmRWhShCZFaFKEJuUJ7iwifVdu9uQAAAAASUVORK5CYII=', 'base64');
const attachments: Attachment[] = [
  { kind: 'file', name: 'requirements.bin', mimeType: 'application/octet-stream', data: fileBytes.toString('base64') },
  { kind: 'image', name: 'reference.png', mimeType: 'image/png', data: imageBytes.toString('base64') },
];

type Frame = { id: number; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Wire = { requests: Frame[]; responses: Frame[] };

async function wire(page: BrowserPage): Promise<Wire> {
  return page.evaluate<Wire>('globalThis.__startupWire');
}

async function request<M extends 'drafts.prepare' | 'threads.create' | 'turns.start'>(page: BrowserPage, method: M): Promise<RpcParams<M>> {
  const held = (await wire(page)).requests.filter(frame => frame.method === method).at(-1);
  expect(held).toBeDefined();
  return held!.params as RpcParams<M>;
}

async function prepared(page: BrowserPage): Promise<RpcResult<'drafts.prepare'>> {
  await page.waitFor(`(() => { const w = globalThis.__startupWire; const r = w.requests.filter(f => f.method === 'drafts.prepare').at(-1); return r && w.responses.some(f => f.id === r.id && f.result?.threadId); })()`);
  const w = await wire(page);
  const r = w.requests.filter(frame => frame.method === 'drafts.prepare').at(-1)!;
  return w.responses.find(frame => frame.id === r.id)!.result as RpcResult<'drafts.prepare'>;
}

async function poll(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(100);
  }
}

function bodies(dataDir: string): Buffer[] {
  const root = join(dataDir, 'attachment-uploads');
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === 'body')
    .map(entry => readFileSync(join(entry.parentPath, entry.name)));
}

async function attach(page: BrowserPage): Promise<void> {
  // Exercise the file picker with binary data, then the composer's image paste path.
  for (const attachment of attachments) {
    await page.evaluate(`(() => {
      const item = ${JSON.stringify(attachment)};
      const bytes = Uint8Array.from(atob(item.data), c => c.charCodeAt(0));
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], item.name, {type:item.mimeType}));
      if (item.kind === 'file') {
        const input = document.querySelector('[data-testid=composer-file]'); input.files = transfer.files;
        input.dispatchEvent(new Event('change', {bubbles:true}));
      } else document.querySelector('[data-testid=composer-input]').dispatchEvent(new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:transfer}));
    })()`);
  }
  // A tile shows before its file is read: the uploads start once both are ready.
  await page.waitFor('document.querySelectorAll("[data-testid=composer-attachment]:not([data-loading])").length === 2');
  await page.waitFor(`(() => { const w = globalThis.__startupWire; return w.requests.filter(f => f.method === 'attachments.upload').slice(-2).filter(r => w.responses.some(f => f.id === r.id && f.result?.id)).length === 2; })()`);
}

async function capture(page: BrowserPage, name: string): Promise<void> {
  await page.settleAnimations();
  await page.evaluate('document.fonts.ready');
  if (name.endsWith('-sent.png')) {
    const point = await page.evaluate<{x:number;y:number}>(`(() => { const r = document.querySelector('[data-testid=timeline]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await page.send('Input.dispatchMouseEvent', {type:'mouseWheel', ...point, deltaX:0, deltaY:-10000});
    await page.waitFor(`(() => { const r = document.querySelector('[data-testid=image-part]')?.getBoundingClientRect(); return r && r.top >= 60 && r.bottom < innerHeight - 130; })()`);
  }
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(artifacts, name));
}

async function newDraft(page: BrowserPage, phone: boolean): Promise<void> {
  if (phone) await newMobileThread(page);
  else await page.click('[data-testid=new-thread]');
  await page.waitFor('document.querySelector("[data-testid=draft-empty]") && document.querySelector("[data-testid=composer-input]")?.value === ""');
}

for (const phone of [false, true]) {
  const size = phone ? 'phone' : 'desktop';
  test(`production ${size} prepares invisibly, preuploads attachments, reuses the native session and releases abandoned drafts`, async () => {
    ensureProductionUi();
    const dataDir = freshDataDir();
    const log = join(dataDir, 'codex-startup.log');
    const core = await startCore({ dataDir, env: { BOITE_UI_DIR: UI_DIST, CODEX_FAKE_LOG: log } });
    const client = await connect(core.url, core.token);
    const created: string[] = [], turns: string[] = [];
    client.on('thread.created', event => created.push(event.id));
    client.on('turn.started', event => turns.push(event.threadId));
    let page: BrowserPage | undefined;
    try {
      const profile = { detect: {}, executable: [{ kind: 'path', value: 'bun' }], launch: { args: [join(import.meta.dir, '../../packages/core/test/fixtures/codex-server.ts')] }, isolation: {} };
      mkdirSync(join(dataDir, 'providers'), { recursive: true });
      writeFileSync(join(dataDir, 'providers/codex-fixture.json'), JSON.stringify({
        id: 'codex-fixture', schemaVersion: 1, name: 'Codex fixture', shortName: 'Codex', protocol: 'codex-appserver', roots: ['{isolationDir}'],
        profiles: { windows: profile, linux: profile, macos: profile }, auth: { kind: 'none' },
        models: [{ id: 'fake-smart', name: 'Fake Smart', default: true }],
        capabilities: { approvals: true, hooks: false, checkpoint: false, images: true, planMode: false, resume: true },
      }));
      expect((await client.call('providers.reload', {})).rejected).toEqual([]);
      const project = await client.call('projects.add', { path: dataDir, name: 'Startup verification' });
      const account = await client.call('accounts.add', { providerId: 'codex-fixture', label: 'Fixture', useDefaultLocation: true });
      // Echo's local title writer avoids an unrelated native title process in this lifecycle proof.
      await client.call('settings.set', { warmProcessMinutes: 0, titleModel: { providerId: 'echo', model: 'echo' } });
      page = await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1280, height: 900 } });
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        localStorage.setItem('boite.composer', ${JSON.stringify(JSON.stringify({ providerId: 'codex-fixture', accountId: account.id, permissionMode: 'default', model: 'fake-smart', effort: null }))});
        globalThis.__startupWire = {requests:[],responses:[]};
        const Native = WebSocket;
        globalThis.WebSocket = class extends Native {
          constructor(...args) { super(...args); this.addEventListener('message', event => { try { const f=JSON.parse(event.data); if (globalThis.__startupWire.requests.some(r => r.id === f.id)) globalThis.__startupWire.responses.push(f); } catch {} }); }
          send(raw) { try { const f=JSON.parse(raw); if (/^(drafts\\.|attachments\\.|threads.create$|turns.start$)/.test(f.method)) globalThis.__startupWire.requests.push(f); } catch {} super.send(raw); }
        };
      ` });
      // Install the recorder before the first app boot. A reload could interrupt
      // the token link after it was stripped but before the connection stored it.
      await page.navigate(pairingUrlOf(core));
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      if (phone) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      const projectPicker = phone ? 'mobile-draft-project' : 'draft-project';
      await page.click(`[data-testid=${projectPicker}]`);
      await page.waitFor(`document.querySelector('[data-testid=${projectPicker}-list] [data-row]')`);
      await page.evaluate(`Array.from(document.querySelectorAll('[data-testid=${projectPicker}-list] [data-row]')).find(row => { try { return JSON.parse(row.dataset.value)[1] === ${JSON.stringify(project.id)}; } catch { return false; } }).click()`);
      const prompt = `Verify ${size} startup and attachment bytes`;
      await page.type('[data-testid=composer-input]', prompt);
      const reservation = await prepared(page);
      const prepareInput = await request(page, 'drafts.prepare');
      expect(prepareInput).not.toHaveProperty('prompt');
      expect(prepareInput.projectId).toBe(project.id);
      expect(await client.call('threads.list', {})).toEqual([]);
      expect(created).toEqual([]);
      expect(turns).toEqual([]);
      expect((await wire(page)).requests.filter(f => f.method === 'threads.create' || f.method === 'turns.start')).toEqual([]);
      await poll(async () => (await client.call('trace.get', {threadId: reservation.threadId})).length > 0 && existsSync(log) && readFileSync(log, 'utf8').includes('thread/start'), 'initialized reserved native process');
      expect(readFileSync(log, 'utf8')).not.toContain('turn/start');
      const native = await client.call('trace.get', {threadId: reservation.threadId});
      expect(native).toHaveLength(1);
      expect(native[0]!.exitedAt).toBeNull();
      await attach(page);
      const uploaded = bodies(dataDir);
      expect(uploaded).toHaveLength(2);
      expect(uploaded.some(body => body.equals(fileBytes))).toBe(true);
      expect(uploaded.some(body => body.equals(imageBytes))).toBe(true);
      expect(await client.call('threads.list', {})).toEqual([]);
      expect(turns).toEqual([]);
      expect(readFileSync(log, 'utf8')).not.toContain('turn/start');
      await capture(page, `agent-startup-${size}-draft.png`);

      const finished = client.next('turn.finished', event => event.threadId === reservation.threadId);
      await page.click('[data-testid=composer-send]');
      const done = await finished;
      expect(done.status).toBe('done');
      await page.waitFor('document.querySelector("[data-testid=thread-header]")?.dataset.status === "idle"');
      const createInput = await request(page, 'threads.create');
      expect(createInput.preparationId).toBe(prepareInput.preparationId);
      const sendInput = await request(page, 'turns.start');
      expect(sendInput.threadId).toBe(reservation.threadId);
      expect(sendInput.attachments?.map(item => item.data)).toEqual(['', '']);
      expect(sendInput.attachmentIds).toHaveLength(2);
      expect(sendInput.attachmentIds?.every(Boolean)).toBe(true);
      expect(created).toEqual([reservation.threadId]);
      expect(turns).toEqual([reservation.threadId]);
      expect((await client.call('threads.list', {})).map(thread => thread.id)).toEqual([reservation.threadId]);
      expect((await client.call('trace.get', {threadId: reservation.threadId})).map(p => p.pid)).toEqual([native[0]!.pid]);
      const thread = await client.call('threads.get', { threadId: reservation.threadId });
      const user = thread.messages.filter(message => message.role === 'user');
      expect(user).toHaveLength(1);
      const image = user[0]!.parts.find(part => part.type === 'image');
      const file = user[0]!.parts.find(part => part.type === 'file');
      expect(image?.type === 'image' && Buffer.from(image.data, 'base64').equals(imageBytes)).toBe(true);
      expect(file?.type === 'file' && Buffer.from(file.data, 'base64').equals(fileBytes)).toBe(true);
      // The scripted native provider echoes its input, proving the actual file reference it received.
      const echoed = thread.messages.filter(message => message.role === 'assistant').flatMap(message => message.parts)
        .filter(part => part.type === 'text').map(part => part.text).join('');
      const referenceLine = echoed.split('\n').find(line => line.startsWith('{"name":"requirements.bin","path":'));
      expect(referenceLine).toBeDefined();
      const reference = JSON.parse(referenceLine!) as {path:string;bytes:number};
      expect(reference.bytes).toBe(fileBytes.length);
      expect(readFileSync(reference.path).equals(fileBytes)).toBe(true);
      expect(readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('turn/start'))).toHaveLength(1);
      expect(readFileSync(log, 'utf8')).toContain(`image data:image/png;base64,${imageBytes.toString('base64')}`);
      await page.waitFor('document.querySelector("[data-testid=image-part]")?.naturalWidth === 240 && document.querySelector("[data-testid=file-part]")');
      await capture(page, `agent-startup-${size}-sent.png`);
      await poll(() => bodies(dataDir).length === 0, 'claimed upload cleanup');

      await newDraft(page, phone);
      await page.type('[data-testid=composer-input]', 'Abandon this prepared draft');
      const abandoned = await prepared(page);
      await attach(page);
      expect(bodies(dataDir)).toHaveLength(2);
      await poll(async () => (await client.call('trace.get', {threadId: abandoned.threadId})).length > 0, 'abandoned draft process');
      const abandonedPids = (await client.call('trace.get', {threadId: abandoned.threadId})).map(p => p.pid);
      await newDraft(page, phone);
      await page.waitFor(`globalThis.__startupWire.requests.some(f => f.method === 'drafts.release' && f.params.preparationId === ${JSON.stringify(abandoned.preparationId)})`);
      await poll(async () => { const trace = await client.call('trace.get', {threadId: abandoned.threadId}); return abandonedPids.every(pid => trace.some(p => p.pid === pid && p.exitedAt !== null)); }, 'abandoned native process exit');
      await poll(() => bodies(dataDir).length === 0, 'abandoned upload cleanup');
      expect((await client.call('threads.list', {})).map(item => item.id)).toEqual([reservation.threadId]);
      expect(created).toEqual([reservation.threadId]);
      expect(turns).toEqual([reservation.threadId]);
      expect(page.errors()).toEqual([]);
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `agent-startup-${size}-proof.json`), JSON.stringify({
        viewport: phone ? [390, 844] : [1280, 900], preparedThreadId: reservation.threadId, reusedPid: native[0]!.pid,
        abandonedThreadId: abandoned.threadId, abandonedPids, created, turns,
        fileBytes: fileBytes.length, imageBytes: imageBytes.length, providerLog: readFileSync(log, 'utf8'), wire: await wire(page),
      }, null, 2));
      console.log(`STARTUP_E2E_OK ${size} invisible=1 preuploads=2 turns=1 native_reused=1 abandoned_reaped=1 bytes_verified=1`);
    } catch (error) {
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, `agent-startup-${size}-core.log`), core.output());
      if (page) { await page.screenshot(join(artifacts, `agent-startup-${size}-failure.png`)).catch(() => undefined); }
      throw error;
    } finally { await page?.close(); client.close(); await core.stop(); }
  }, 120_000);
}
