import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { mintPairing, pairingUrlOf, startCore } from './lib/core.ts';

test('agent deliverables and file links open in chat on desktop and paired phone', async () => {
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    const projectDir = join(core.dataDir, '.boite', 'worktrees', 'handoff');
    mkdirSync(projectDir, { recursive: true });
    const project = await client.call('projects.add', { path: projectDir, name: 'Deliverables' });
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Project handoff' });
    writeFileSync(join(projectDir, 'notes.txt'), 'Ready for review.\nTwo proposals and annotated previews.');
    const picturePath = join(projectDir, 'tests', 'e2e', '.artifacts', 'preview.png').replaceAll('\\', '/');
    mkdirSync(join(projectDir, 'tests', 'e2e', '.artifacts'), { recursive: true });
    writeFileSync(picturePath, readFileSync(join(import.meta.dir, '../../packages/ui/public/icons/icon-192.png')));
    const objects = [
      '<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
      '<</Length 44>>\nstream\nBT /F1 24 Tf 40 230 Td (Project handoff) Tj ET\nendstream',
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
    ];
    let document = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) { offsets.push(document.length); document += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
    const xref = document.length;
    document += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(at => `${String(at).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
    const pdf = Buffer.from(document);
    writeFileSync(join(projectDir, 'handoff.pdf'), pdf);
    await client.call('threads.subscribe', { threadId: thread.id });
    const done = client.next('turn.finished');
    const notesPath = join(projectDir, 'notes.txt').replaceAll('\\', '/');
    const notesLink = process.platform === 'win32' ? `/${notesPath}` : notesPath;
    const pictureLink = process.platform === 'win32' ? `/${picturePath}` : picturePath;
    await client.call('turns.start', { threadId: thread.id, prompt: `Your deliverable is attached below. Read [project notes](<${notesLink}:2>), [the capture](<${pictureLink}>), [the PDF](handoff.pdf), or https://example.com/review.` });
    await done;
    await client.call('artifacts.publish', { threadId: thread.id, path: 'handoff.pdf' });
    await client.call('artifacts.publish', { threadId: thread.id, path: 'tests/e2e/.artifacts/preview.png' });
    for (const mobile of [false, true]) {
      page = await BrowserPage.launch({ url: mobile ? await mintPairing(core) : pairingUrlOf(core) });
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      await page.evaluate('localStorage.setItem("boite.experiments", JSON.stringify(["chat-artifacts"])); location.reload()');
      await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      await page.click(`[data-thread-id="${thread.id}"]`);
      await page.waitFor('document.querySelector("[data-testid=artifact-download]")');
      if (mobile) await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      expect(await page.evaluate('document.querySelector("[data-testid=artifact-download]").download')).toBe('handoff.pdf');
      const downloaded = await page.evaluate<string>('fetch(document.querySelector("[data-testid=artifact-download]").href).then(r => r.text())');
      expect(downloaded).toBe(pdf.toString());
      expect(await page.evaluate(`document.querySelector('[data-testid=text-part] a[href="https://example.com/review"]') !== null`)).toBe(true);
      // Published images are already visible; their preview needs no extra click.
      await page.waitFor('document.querySelector("[data-testid=artifact-enlarge] img")?.naturalWidth === 192');
      // An attached picture opens full size from its name, over the whole window.
      await page.evaluate('Array.from(document.querySelectorAll("[data-testid=artifact-launch]")).find(b => b.textContent.includes("preview.png")).click()');
      await page.waitFor('document.querySelector("[data-testid=image-viewer] img")?.naturalWidth === 192');
      await page.evaluate('Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})))');
      await page.screenshot(join(import.meta.dir, '.artifacts', `artifacts-viewer-${mobile ? 'phone' : 'desktop'}.png`));
      await page.click('[data-testid=image-viewer-close]');
      await page.waitFor('document.querySelector("[data-testid=image-viewer]") === null');
      await page.click(`a[data-file-path=${JSON.stringify(notesPath)}]`);
      await page.waitFor(mobile ? 'document.querySelector("[data-testid=chat-file] [role=alert]")' : 'document.querySelector("[data-testid=artifact-content] pre")');
      expect(await page.text('[data-testid=chat-file]')).toContain(mobile ? 'owner connection' : 'Ready for review.');
      await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
      await page.screenshot(join(import.meta.dir, '.artifacts', `artifacts-${mobile ? 'phone' : 'desktop'}.png`));
      if (!mobile) {
        await page.click(`a[data-file-path=${JSON.stringify(picturePath)}]`);
        // The published picture is already loaded. Wait for the preview opened by this link.
        const linkedImage = '[data-testid="chat-file"]:has([data-testid="artifact-preview"]) [data-testid="artifact-content"] img';
        await page.waitFor(`document.querySelector(${JSON.stringify(linkedImage)})?.naturalWidth > 0`);
        expect(await page.evaluate(`document.querySelector(${JSON.stringify(linkedImage)}).naturalWidth`)).toBe(192);
        await page.screenshot(join(import.meta.dir, '.artifacts', 'artifacts-image-desktop.png'));
        await page.evaluate('Array.from(document.querySelectorAll("[data-testid=chat-file]")).find(card => card.textContent.includes("handoff.pdf")).querySelector("[data-testid=artifact-preview]").click()');
        await page.waitFor('document.querySelector("[data-testid=artifact-content] iframe")');
        // Chromium's PDF viewer paints asynchronously after the frame has loaded.
        await Bun.sleep(1500);
        await page.screenshot(join(import.meta.dir, '.artifacts', 'artifacts-pdf-desktop.png'));
      }
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.close(); page = undefined;
    }
  } finally { await page?.close(); client.close(); await core.stop(); }
}, 90_000);
