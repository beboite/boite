import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { echoThread, startTestCore, waitFor } from '../../packages/core/test/harness.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf } from './lib/core.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';
import { mobileAction } from './lib/mobile.ts';

test('the real task manager reads owned processes on desktop and a paired phone', async () => {
  ensureProductionUi();
  const harness = await startTestCore();
  let desktop: BrowserPage | undefined;
  let phone: BrowserPage | undefined;
  const serverId = 'resource-fixture-server';
  let threadId: string | undefined;
  try {
    const owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner, 'Local activity fixture'));
    const serverCode = "const net=require('node:net');const server=net.createServer(s=>s.on('data',()=>s.write(Buffer.alloc(8192))));server.listen(0,'127.0.0.1',()=>console.log(server.address().port));";
    const server = harness.core.procs.spawnPiped(serverId, process.execPath, ['-e', serverCode], { cwd: harness.dataDir });
    const port = Number(new TextDecoder().decode((await server.proc.stdout.getReader().read()).value).trim());
    expect(port).toBeGreaterThan(0);
    const activityCode = "const net=require('node:net'),fs=require('node:fs');const socket=net.connect(Number(process.argv[1]),'127.0.0.1',()=>{setInterval(()=>{socket.write(Buffer.alloc(16384));const fd=fs.openSync('activity.bin','w');fs.writeSync(fd,Buffer.alloc(65536));fs.fsyncSync(fd);fs.closeSync(fd)},200)});socket.on('data',()=>{});setInterval(()=>{const end=performance.now()+2;while(performance.now()<end){}},50);";
    const activity = harness.core.procs.spawn(threadId, process.execPath, ['-e', activityCode, String(port), 'fixture-private-marker'], { cwd: harness.dataDir });
    desktop = await BrowserPage.launch({ url: pairingUrlOf(harness), windowSize: { width: 1280, height: 900 } });
    const renderer = await desktop.evaluate(`(() => { const gl = document.createElement('canvas').getContext('webgl2'); const info = gl?.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null; })()`);
    console.log(JSON.stringify({ scenario: 'Task manager', renderer }));
    await desktop.waitFor(`document.querySelector('[data-testid=status-connection]')?.dataset.state === 'ready'`);
    await desktop.click('[data-testid=nav-settings]');
    await desktop.click('[data-testid=settings-tab-task-manager]');
    const selector = `[data-testid=task-manager-agent][data-thread-id="${threadId}"]`;
    await desktop.waitFor(`document.querySelector('${selector}')`);
    if (process.platform === 'linux') {
      await waitFor(() => {
        const row = harness.core.procs.resourceUsage().agents.find(row => row.threadId === threadId);
        return !!row && (row.disk.writeBytes ?? 0) > 0 && (row.network.writeBytes ?? 0) > 0 && (row.network.readBytes ?? 0) > 0;
      }, 10000);
      await desktop.waitFor(`document.querySelector('${selector} [data-testid=task-manager-network] small') && document.querySelector('${selector} [data-testid=task-manager-disk] small')`, 15000);
      const sample = await owner.call('resources.usage', {});
      const row = sample.agents.find(row => row.threadId === threadId)!;
      expect(row.disk.writeBytes).toBeGreaterThan(0);
      expect(row.network.writeBytes).toBeGreaterThan(0);
      expect(row.network.readBytes).toBeGreaterThan(0);
      expect(row.loadAvailable).toEqual({ cpu: true, memory: true });
      await desktop.waitFor(`/[1-9]/.test(document.querySelector('${selector} [data-testid=task-manager-network] dd')?.textContent ?? '')`, 10000);
    }
    expect(await desktop.evaluate(`document.querySelector('[data-testid=task-manager]').textContent.includes('fixture-private-marker')`)).toBe(false);
    expect(await desktop.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
    await desktop.evaluate('document.fonts.ready');
    await desktop.screenshot(join(import.meta.dir, '.artifacts', 'task-manager-desktop.png'));
    const history = await owner.call('threads.get', { threadId });
    await desktop.click(`${selector} .title`);
    await desktop.waitFor(`!document.querySelector('[data-testid=task-manager]') && document.querySelector('[data-testid=composer-input]')`);
    expect(await desktop.evaluate(`document.querySelector('[data-testid=thread-title]')?.textContent`)).toBe(history.title);
    await desktop.click('[data-testid=nav-settings]');
    await desktop.click('[data-testid=settings-tab-task-manager]');
    await desktop.waitFor(`document.querySelector('${selector}')`);

    const { url } = await owner.call('pairing.grant', {});
    phone = await BrowserPage.launch({ url, windowSize: { width: 390, height: 844 } });
    await phone.waitFor(`document.querySelector('[data-testid=status-connection]')?.dataset.state === 'ready'`);
    for (const from of ['mobile-conversations', 'mobile-activity']) {
      await mobileAction(phone, from);
      await phone.waitFor(`document.querySelector('[data-testid=mobile-list]')`);
      await mobileAction(phone, 'mobile-settings');
      await phone.click('[data-testid=settings-tab-task-manager]');
      await phone.waitFor(`document.querySelector('${selector}')`);
      expect(await phone.evaluate(`document.querySelector('${selector} .actions') === null`)).toBe(true);
      expect(await phone.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
      await phone.evaluate('document.fonts.ready');
      await phone.screenshot(join(import.meta.dir, '.artifacts', 'task-manager-phone.png'));
      await phone.click(`${selector} .title`);
      await phone.waitFor(`document.querySelector('.app.phone-chat') && !document.querySelector('[data-testid=mobile-list]') && !document.querySelector('[data-testid=task-manager]') && document.querySelector('[data-testid=composer-input]')`);
      expect(await phone.evaluate(`document.querySelector('[data-testid=thread-title]')?.textContent`)).toBe(history.title);
    }
    await mobileAction(phone, 'mobile-settings');
    await phone.click('[data-testid=settings-tab-task-manager]');
    await phone.waitFor(`document.querySelector('${selector}')`);
    await phone.click('[data-testid=mobile-settings-back]');
    await phone.waitFor(`document.querySelector('[data-testid=mobile-settings-home]') && !document.querySelector('[data-testid=task-manager]')`);

    await desktop.click(`${selector} .actions button`);
    await desktop.click(`${selector} .actions button.danger`);
    await desktop.waitFor(`!document.querySelector('${selector}')`);
    await activity.exited;
    expect((await owner.call('resources.usage', {})).agents.some(row => row.threadId === threadId)).toBe(false);
  } finally {
    const closed = await Promise.allSettled([desktop?.close(), phone?.close(),
      threadId ? harness.core.procs.stopAndWait(threadId) : undefined,
      harness.core.procs.stopAndWait(serverId)]);
    await harness.stop();
    const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Task manager fixture cleanup failed');
  }
}, 60000);
