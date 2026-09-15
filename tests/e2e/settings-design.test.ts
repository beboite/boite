import { expect, test } from "bun:test";
import { BrowserPage, freePort } from "./lib/cdp";
import { join } from "node:path";
import { createRequire } from "node:module";

const uiRequire = createRequire(join(import.meta.dir, "../../packages/ui/package.json"));
const { createServer } = await import(uiRequire.resolve("vite"));

test("settings reveal sections and protection switches persist across navigation", async () => {
  const port = await freePort();
  const server = await createServer({
    root: join(import.meta.dir, "../../packages/ui"),
    server: { host: "127.0.0.1", port, strictPort: true },
    clearScreen: false,
  });
  await server.listen();
  const page = await BrowserPage.launch({
    url: `http://127.0.0.1:${port}/?fake=1`,
    windowSize: { width: 1440, height: 1000 },
  });
  async function settled() {
    await page.evaluate(
      `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
    );
    await page.evaluate("document.fonts.ready");
  }
  try {
    await page.click("[data-testid=nav-settings]");
    await page.waitFor('document.querySelector("[data-testid=settings-page]")');
    await settled();
    await page.screenshot("tests/e2e/.artifacts/settings-after.png");
    await page.click("[data-testid=settings-tab-resources]");
    await page.waitFor(
      'document.querySelector("[data-testid=setting-focus-guard]")',
    );
    await settled();
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=settings-tab-resources]").getAttribute("aria-expanded")',
      ),
    ).toBe("true");
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=settings-tab-general]").getAttribute("aria-expanded")',
      ),
    ).toBe("false");
    await page.screenshot("tests/e2e/.artifacts/protection-desktop.png");
    await page.click("[data-testid=setting-mute-agents]");
    await page.waitFor(
      '!document.querySelector("[data-testid=setting-mute-agents]").checked',
    );
    await page.click("[data-testid=settings-tab-general]");
    await page.click("[data-testid=settings-tab-resources]");
    await page.waitFor(
      '!document.querySelector("[data-testid=setting-mute-agents]").checked',
    );
    expect(await page.evaluate('document.fonts.check("14px Geist")')).toBe(
      true,
    );
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await settled();
    await page.screenshot("tests/e2e/.artifacts/protection-phone.png");
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await settled();
    await page.screenshot("tests/e2e/.artifacts/protection-light.png");
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
  } finally {
    await page.close();
    await server.close();
  }
}, 60_000);
