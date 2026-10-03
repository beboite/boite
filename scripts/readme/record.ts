import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureBridge } from '../../tests/e2e/lib/ui';
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from '../../packages/ui/src/lib/onboarding';

// Tool-only dependencies stay outside the application's lockfile.
const arg = (name: string, fallback: string) => {
  const index = Bun.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Bun.argv[index + 1] ?? fallback;
};
const root = resolve(import.meta.dir, '../..');
const ui = join(root, 'packages/ui');
const output = resolve(arg('output', join(root, 'docs/media')));
const scratch = resolve(arg('scratch', join(root, 'tests/e2e/.artifacts/readme')));
const ffmpegArg = arg('ffmpeg', 'ffmpeg');
const ffmpeg = Bun.which(ffmpegArg) ?? resolve(ffmpegArg);
const inspect = Bun.argv.includes('--inspect');
const combineOnly = Bun.argv.includes('--combine-only');
if (inspect && combineOnly) throw new Error('Choose either --inspect or --combine-only');
mkdirSync(output, { recursive: true }); mkdirSync(scratch, { recursive: true });

if (!combineOnly) {
const requireUi = createRequire(join(ui, 'package.json'));
const { createServer } = await import(requireUi.resolve('vite'));
const moduleName = arg('playwright', 'playwright-core');
const { chromium } = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName);
const server = await createServer({ root: ui, plugins: [fixtureBridge, {
  name: 'readme-film',
  transform(code: string, id: string) {
    if (id.replaceAll('\\', '/') !== join(ui, 'src/lib/fake-client.ts').replaceAll('\\', '/')) return;
    return `${code.replace('if (options.delegationDemo) seedDelegationDemo(ctx);', 'if (options.delegationDemo) seedDelegationDemo(ctx); seedReadme(ctx);')}\nimport { seedReadme } from '../../../../scripts/readme/fixture';`;
  },
  configureServer(vite: any) {
    vite.middlewares.use((req: any, res: any, next: () => void) => {
      if (req.url?.startsWith('/__readme-stage')) {
        res.setHeader('Content-Type', 'text/html'); res.end(readFileSync(join(import.meta.dir, 'stage.html')));
      } else next();
    });
  },
}], server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn', clearScreen: false });
await server.listen();
const base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
let browser: any;
try {
  browser = await chromium.launch({ executablePath: arg('browser', '/usr/bin/google-chrome'), headless: true, chromiumSandbox: true,
    args: ['--mute-audio', '--enable-gpu', '--use-gl=angle', '--use-angle=gl-egl', '--disable-software-rasterizer'] });
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', colorScheme: theme,
      ...(inspect ? {} : { recordVideo: { dir: scratch, size: { width: 1600, height: 1000 } } }) });
    try {
      await context.addInitScript(({ theme, key, version }: any) => {
        localStorage.setItem('boite.theme', theme); localStorage.setItem('boite.locale', 'en');
        localStorage.setItem('boite:right-panel-width', '510');
        localStorage.setItem(key, JSON.stringify({ version, at: 0 }));
      }, { theme, key: ONBOARDING_STORAGE_KEY, version: ONBOARDING_VERSION });
      const recordingAt = Date.now();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error: Error) => { errors.push(error.message); console.error('PAGE_ERROR', error.message); });
      const badRequests: string[] = [];
      page.on('response', (response: any) => { if (response.status() >= 400) badRequests.push(`${response.status()} ${response.url()}`); });
      await page.goto(`${base}/__readme-stage?theme=${theme}`, { waitUntil: 'load', timeout: 60000 });
      const deskElement = await page.$('#desktop'); const desk = await deskElement.contentFrame();
      for (const frame of [desk]) {
        await frame.waitForFunction(() => (globalThis as any).__boiteTest?.workspace.active.booted).catch(async (error: Error) => {
          console.error('BOOT_STATE', await frame.evaluate(() => ({ text: document.body.innerText, bridge: !!(globalThis as any).__boiteTest, state: (globalThis as any).__boiteTest?.workspace.active.client.state })));
          await page.screenshot({ path: join(scratch, 'boot-failed.png') }); throw error;
        });
        await frame.evaluate(async () => { const s = (globalThis as any).__boiteTest.workspace.active; await s.open('t-trace'); s.panel.closeAll(); });
        await frame.locator('[data-testid=timeline]').waitFor();
        await frame.evaluate(() => document.fonts.ready);
      }
      const renderer = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const debug = gl?.getExtension('WEBGL_debug_renderer_info');
        return debug ? gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
      });
      if (!renderer || /swiftshader|llvmpipe|softpipe/i.test(renderer)) throw new Error(`Hardware rendering unavailable: ${renderer}`);
      const lead = (Date.now() - recordingAt) / 1000;
      const scenes: { scene: string; start: number; end: number; duration: number }[] = [];
      const fullscreen = await deskElement.boundingBox();
      if (fullscreen?.x !== 0 || fullscreen?.y !== 0 || fullscreen?.width !== 1600 || fullscreen?.height !== 1000) throw new Error('Boite does not fill the video frame');
      const filmAt = Date.now();
      const hold = async (seconds: number) => { if (!inspect) await Bun.sleep(seconds * 1000); };
      const shot = async (name: string) => {
        await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
        await page.screenshot({ path: join(scratch, `${theme}-${name}.png`) });
      };
      const click = async (frame: any, selector: string) => {
        const target = frame.locator(selector).first(); await target.waitFor({ state: 'visible' });
        const box = await target.boundingBox(); if (!box) throw new Error(`No box for ${selector}`);
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        await page.evaluate(({ x, y }: any) => { document.getElementById('cursor')!.style.transform = `translate(${x}px,${y}px)`; }, { x, y });
        await page.mouse.move(x, y, { steps: 28 }); await hold(.45);
        await page.evaluate(({ x, y }: any) => {
          const pulse = document.getElementById('pulse')!; pulse.style.left = `${x - 22}px`; pulse.style.top = `${y - 22}px`;
          pulse.classList.remove('pressed'); void pulse.offsetWidth; pulse.classList.add('pressed');
        }, { x, y });
        await page.mouse.click(x, y);
      };
      const begin = (scene: string, duration: number) => {
        const at = (Date.now() - filmAt) / 1000;
        if (scenes.length) scenes.at(-1)!.end = at;
        scenes.push({ scene, start: at, end: at, duration });
      };
      begin('workspace', 2);
      await desk.locator('[data-testid=timeline]').evaluate((el: HTMLElement) => { el.scrollTop = 0; });
      await shot('workspace');
      await page.screenshot({ path: join(output, `boite-${theme}.png`) });
      await hold(1);
      await desk.locator('[data-testid=timeline]').evaluate((el: HTMLElement) => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }));
      await hold(1);
      begin('models', 3);
      await click(desk, '[data-testid=composer-picker]');
      await click(desk, '[data-provider=codex]');
      await desk.locator('[data-testid=composer-picker-menu] [data-model]').first().waitFor();
      await shot('models'); await hold(1);
      await click(desk, '[data-testid=composer-picker-menu] [data-model="gpt-6-astra"]');
      await desk.locator('[data-testid=composer-picker-menu]').waitFor({ state: 'hidden' });
      await hold(.5);
      begin('changes', 4);
      await click(desk, '[data-testid=panel-toggle]');
      await click(desk, '[data-testid=launch-changes]');
      await click(desk, '[data-testid=changes-row][data-path="src/components/RightPanel.svelte"]');
      await desk.locator('[data-testid=diff-view]').waitFor();
      await shot('changes'); await hold(2);
      begin('team', 3);
      await desk.evaluate(() => { (globalThis as any).__boiteTest.workspace.active.panel.closeAll(); });
      await click(desk, '[data-testid=delegation-activity]');
      await desk.locator('[data-testid=delegation-member]').first().waitFor();
      await shot('team'); await hold(.5);
      await click(desk, '[data-testid=delegation-member]');
      await desk.locator('[data-testid=delegation-detail]').waitFor();
      await shot('team-detail'); await hold(1.5);
      scenes.at(-1)!.end = (Date.now() - filmAt) / 1000;
      if (errors.length || badRequests.length) throw new Error(JSON.stringify({ errors, badRequests }));
      const seconds = (Date.now() - filmAt) / 1000;
      const video = page.video();
      await context.close();
      if (!inspect) {
        const raw = await video.path();
        // Fit every interaction into its allotted scene without cutting away clicks.
        const montage = scenes.map((scene, i) => `[0:v]trim=start=${lead + scene.start}:end=${lead + scene.end},setpts=(PTS-STARTPTS)*${scene.duration / (scene.end - scene.start)}[v${i}]`).join(';') + `;${scenes.map((_, i) => `[v${i}]`).join('')}concat=n=${scenes.length}:v=1:a=0,fps=30[film]`;
        await encode(['-i', raw, '-filter_complex', montage, '-map', '[film]', '-t', '12', '-an', '-c:v', 'libx264', '-threads', '4', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(scratch, `boite-${theme}.mp4`)]);
      }
      await Bun.write(join(scratch, `${theme}-verification.json`), JSON.stringify({ renderer, errors, badRequests, fullscreen, recordingSeconds: seconds, filmSeconds: 12, scenes }, null, 2));
      console.log(`README_FILM_OK theme=${theme} fullscreen=1600x1000 seconds=12 errors=${errors.length} hardware=${renderer}`);
    } finally { await context.close(); }
  }
} finally { await browser?.close(); await server.close(); }
}

if (!inspect) {
  // Both films reach the same settled diff view before changing themes.
  const fade = '[0:v]trim=end=8.4,setpts=PTS-STARTPTS,fps=30,settb=1/30[light];[1:v]trim=start=7.6,setpts=PTS-STARTPTS,fps=30,settb=1/30[dark];[light][dark]xfade=transition=fade:duration=0.8:offset=7.6[film]';
  await encode(['-i', join(scratch, 'boite-light.mp4'), '-threads', '4', '-i', join(scratch, 'boite-dark.mp4'), '-filter_complex', fade, '-map', '[film]', '-t', '12', '-an', '-c:v', 'libx264', '-threads', '4', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(output, 'boite.mp4')]);
  const filters = 'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[gif]';
  await encode(['-i', join(output, 'boite.mp4'), '-filter_complex', filters, '-map', '[gif]', '-loop', '0', join(output, 'boite.gif')]);
  if (statSync(join(output, 'boite.gif')).size > 5 * 1024 * 1024) throw new Error('README GIF exceeds 5 MiB');
  console.log('README_COMBINED_OK fullscreen=1600x1000 seconds=12 fade=light-to-dark transition=7.6-8.4');
}

async function encode(args: string[]) {
  const proc = Bun.spawn([ffmpeg, '-y', '-threads', '4', '-filter_complex_threads', '2', ...args], { stdout: 'ignore', stderr: 'pipe' });
  const log = await new Response(proc.stderr).text();
  await Bun.write(join(scratch, `${basename(args.at(-1)!)}.encode.log`), log);
  if (await proc.exited !== 0) throw new Error(`FFmpeg failed:\n${log}`);
}
