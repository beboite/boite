import { expect, test } from "bun:test";
import { BrowserPage, freePort } from "./lib/cdp";
import { startUi } from "./lib/ui.ts";

test("settings reveal sections and protection switches persist across navigation", async () => {
  const port = await freePort();
  const server = await startUi(port);
  const page = await BrowserPage.launch({
    url: `http://127.0.0.1:${port}/?fake=1&open=recent`,
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
    await page.waitFor('document.querySelector("[data-testid=settings-home]")');
    await settled();
    await page.screenshot("tests/e2e/.artifacts/settings-after.png");
    await page.click("[data-testid=settings-tab-resources]");
    await page.waitFor(
      'document.querySelector("[data-testid=setting-focus-guard]")',
    );
    await settled();
    // Only pages several screens long list their sections: Protection and General fit without them.
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=settings-tab-resources]").getAttribute("aria-expanded")',
      ),
    ).toBeNull();
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=settings-tab-general]").getAttribute("aria-expanded")',
      ),
    ).toBeNull();
    expect(
      await page.evaluate(
        'document.querySelector("[data-testid=settings-tab-usage]").getAttribute("aria-expanded")',
      ),
    ).toBe("false");
    await page.screenshot("tests/e2e/.artifacts/protection-desktop.png");
    await page.click("[data-testid=setting-mute-agents]");
    await page.waitFor(
      '!document.querySelector("[data-testid=setting-mute-agents]").checked',
    );
    await page.click("[data-testid=setting-reap-orphans]");
    await page.waitFor(
      '!document.querySelector("[data-testid=setting-reap-orphans]").checked',
    );
    await page.click("[data-testid=settings-tab-general]");
    await page.click("[data-testid=settings-tab-resources]");
    await page.waitFor(
      '!document.querySelector("[data-testid=setting-mute-agents]").checked',
    );
    await page.waitFor(
      '!document.querySelector("[data-testid=setting-reap-orphans]").checked',
    );
    expect(await page.evaluate('document.fonts.check("14px Inter")')).toBe(
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

// French names run long ("Machines et mises à jour"): a tile once let its label
// spill over the next one, and the page hugged the left of a wide window.
test("settings home keeps every tile's words inside it and centres its column", async () => {
  const port = await freePort();
  const server = await startUi(port);
  const page = await BrowserPage.launch({
    url: `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`,
    windowSize: { width: 1440, height: 900 },
  });
  try {
    await page.evaluate("localStorage.setItem('boite.locale', 'fr')");
    await page.evaluate("location.reload()");
    await page.waitFor('document.querySelector("[data-testid=nav-settings]")');
    await page.click("[data-testid=nav-settings]");
    await page.waitFor('document.querySelector("[data-testid=settings-home-machines]")');
    await page.evaluate("document.fonts.ready");
    for (const width of [1920, 1440, 1100, 900]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const layout = JSON.parse(String(await page.evaluate(`(() => {
        const frame = document.querySelector('.settings section.framed').getBoundingClientRect();
        const search = document.querySelector('[data-testid=settings-search]').closest('label').getBoundingClientRect();
        const tiles = [...document.querySelectorAll('[data-testid^=settings-home-]')].filter(tile => tile.tagName === 'BUTTON');
        const spills = tiles.filter(tile => {
          const box = tile.getBoundingClientRect();
          return [...tile.querySelectorAll('span')].some(part => {
            const inner = part.getBoundingClientRect();
            return part.scrollWidth > part.clientWidth + 1 || inner.right > box.right + 0.5 || inner.bottom > box.bottom + 0.5;
          });
        }).map(tile => tile.dataset.testid);
        const heights = [...new Set(tiles.map(tile => Math.round(tile.getBoundingClientRect().height)))];
        return JSON.stringify({ left: search.left - frame.left, right: frame.right - search.right, spills, heights });
      })()`)));
      expect({ width, spills: layout.spills }).toEqual({ width, spills: [] });
      expect({ width, heights: layout.heights }).toEqual({ width, heights: [layout.heights[0]] });
      if (width >= 1440) expect(Math.abs(layout.left - layout.right)).toBeLessThanOrEqual(2);
    }
    // A page with its own root styles (Machines, Protection under its machine bar) centres the same way.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 900, deviceScaleFactor: 1, mobile: false });
    const centred = async (selector: string) => {
      const sides = JSON.parse(String(await page.evaluate(`(() => {
        const frame = document.querySelector('.settings section.framed').getBoundingClientRect();
        const box = document.querySelector('${selector}').getBoundingClientRect();
        return JSON.stringify([box.left - frame.left, frame.right - box.right]);
      })()`)));
      expect({ selector, off: Math.abs(sides[0] - sides[1]) <= 2 }).toEqual({ selector, off: true });
    };
    await page.click("[data-testid=settings-tab-machines]");
    await page.waitFor('document.querySelector("[data-testid=machines-page] > section")');
    await centred("[data-testid=machines-page] > section");
    // A page under the machine bar centres too, and the bar starts where the page does.
    await page.click("[data-testid=settings-tab-resources]");
    await page.waitFor('document.querySelector("[data-testid=settings-machine-bar] [data-testid=settings-machine]") && document.querySelector("[data-testid=resources-page] > *")');
    await centred("[data-testid=resources-page] > *");
    const edges = JSON.parse(String(await page.evaluate(`JSON.stringify([document.querySelector('[data-testid=settings-machine]').getBoundingClientRect().left, document.querySelector('[data-testid=resources-page] > *').getBoundingClientRect().left])`)));
    expect(Math.abs(edges[0] - edges[1])).toBeLessThanOrEqual(2);
  } finally {
    await page.close();
    await server.close();
  }
}, 60_000);
