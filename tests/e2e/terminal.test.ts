import { expect, test } from "bun:test";
import { BrowserPage, freePort } from "./lib/cdp";
import { startUi } from "./lib/ui";

async function settled(page: BrowserPage): Promise<void> {
  await page.evaluate(
    `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
  );
  await page.evaluate("document.fonts.ready");
}

/** A chord the way a keyboard sends it, so it walks through xterm when it holds the focus. */
async function chord(page: BrowserPage, key: string, code: string, keyCode: number): Promise<void> {
  const base = { key, code, windowsVirtualKeyCode: keyCode, modifiers: 2 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

const phone = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };

test("Ctrl+J opens a shell under the thread, typing reaches it, and OpenCode signs in from one", async () => {
  const port = await freePort();
  const server = await startUi(port);
  const page = await BrowserPage.launch({
    url: `http://127.0.0.1:${port}/?fake=1&open=recent`,
    windowSize: { width: 1440, height: 900 },
  });
  try {
    // Exercise normal motion independently of the host preference; reduced motion is checked below.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await page.waitFor('document.querySelector("[data-testid=terminal-toggle]")');
    await settled(page);
    await page.evaluate(`(() => {
      document.documentElement.style.setProperty('--dur-3', '1s');
      const store = globalThis.__boiteTest.workspace.active;
      const call = store.client.call.bind(store.client);
      globalThis.__terminalStarts = 0;
      const gate = new Promise(resolve => { globalThis.__releaseTerminal = resolve; });
      store.client.call = async (method, params) => {
        if (method === 'terminals.open') globalThis.__terminalStarts++;
        const result = await call(method, params);
        if (method === 'terminals.open') await gate;
        return result;
      };
      globalThis.__chatBeforeTerminal = document.querySelector('[data-testid=chat]').getBoundingClientRect().height;
    })()`);
    await chord(page, "j", "KeyJ", 74);
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm")');
    expect(await page.evaluate('globalThis.__terminalStarts')).toBe(1);
    const unfolding = await page.evaluate<{ before: number; during: number; total: number; chat: number }>(`(() => {
      const drawer = document.querySelector('[data-testid=terminal-drawer]');
      const transition = drawer.getAnimations().find(animation => animation.transitionProperty === 'height');
      if (!transition) throw new Error('The frame did not unfold');
      transition.pause();
      transition.currentTime = 150;
      return { before: globalThis.__chatBeforeTerminal, during: drawer.getBoundingClientRect().height,
        total: parseFloat(getComputedStyle(drawer).getPropertyValue('--terminal-height')) + 8,
        chat: document.querySelector('[data-testid=chat]').getBoundingClientRect().height };
    })()`);
    expect(unfolding.during).toBeGreaterThan(0);
    expect(unfolding.during).toBeLessThan(unfolding.total);
    expect(unfolding.chat).toBeLessThan(unfolding.before);
    await page.screenshot('tests/e2e/.artifacts/terminal-unfolding.png');
    await page.evaluate(`(() => {
      document.querySelector('[data-testid=terminal-drawer]').getAnimations().forEach(animation => animation.finish());
      document.documentElement.style.removeProperty('--dur-3');
      globalThis.__releaseTerminal();
    })()`);
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm-rows")?.textContent.includes("PS ")');
    const frame = await page.evaluate<{ gap: number; chatBottom: number; terminalTop: number }>(`(() => {
      const chat = document.querySelector('.thread-chat').getBoundingClientRect();
      const terminal = document.querySelector('[data-testid=terminal-drawer] .surface').getBoundingClientRect();
      return { gap: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame-gap')),
        chatBottom: chat.bottom, terminalTop: terminal.top };
    })()`);
    expect(frame.terminalTop - frame.chatBottom).toBeCloseTo(frame.gap, 0);
    // xterm holds the focus: what is typed goes to the shell.
    await page.send("Input.insertText", { text: "git status" });
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm-rows").textContent.includes("git status")');
    // An app chord still reaches the app from inside the terminal.
    await chord(page, "k", "KeyK", 75);
    await page.waitFor('document.querySelector("[data-testid=palette]")');
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.waitFor('!document.querySelector("[data-testid=palette]")');
    await settled(page);
    await page.screenshot("tests/e2e/.artifacts/terminal-desktop.png");

    await page.send("Emulation.setDeviceMetricsOverride", phone);
    await settled(page);
    await page.screenshot("tests/e2e/.artifacts/terminal-phone.png");
    expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    // A stored desktop height still leaves room for the composer on a short phone viewport.
    await page.send('Emulation.setDeviceMetricsOverride', { ...phone, height: 500 });
    await settled(page);
    expect(await page.evaluate(`(() => {
      const drawer = document.querySelector('[data-testid=terminal-drawer]');
      const composer = document.querySelector('[data-testid=composer-input]').getBoundingClientRect();
      return drawer.getBoundingClientRect().height <= Math.max(120, Math.round(drawer.parentElement.clientHeight * .7)) + 1
        && composer.top >= 0 && composer.bottom <= innerHeight;
    })()`)).toBe(true);
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    await settled(page);

    // Hiding preserves the shell and its command, and reversing the fold remains continuous.
    await page.evaluate(`(() => {
      document.documentElement.style.setProperty('--dur-2', '1s');
      document.documentElement.style.setProperty('--dur-3', '1s');
      globalThis.__boiteTest.workspace.active.toggleTerminal();
    })()`);
    await page.waitFor(`document.querySelector('[data-testid=terminal-drawer]')?.getAnimations().some(a => a.transitionProperty === 'height')`);
    const reversal = await page.evaluate<{ before: number; after: number }>(`(async () => {
      const drawer = document.querySelector('[data-testid=terminal-drawer]');
      const transition = drawer.getAnimations().find(a => a.transitionProperty === 'height');
      transition.pause(); transition.currentTime = 150;
      const before = drawer.getBoundingClientRect().height;
      globalThis.__boiteTest.workspace.active.toggleTerminal();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const reopening = drawer.getAnimations().find(a => a.transitionProperty === 'height');
      if (!reopening) throw new Error('The frame did not reverse its fold');
      reopening.pause(); reopening.currentTime = 0;
      const after = drawer.getBoundingClientRect().height;
      reopening.play();
      document.documentElement.style.removeProperty('--dur-2');
      document.documentElement.style.removeProperty('--dur-3');
      return { before, after };
    })()`);
    expect(reversal.before).toBeGreaterThan(0);
    expect(Math.abs(reversal.after - reversal.before)).toBeLessThan(1);
    await settled(page);
    expect(await page.evaluate(`document.querySelector('[data-testid=terminal-drawer] .xterm-rows').textContent.includes('git status')`)).toBe(true);
    await page.evaluate('document.documentElement.dataset.motion = "reduced"');
    await page.click('[data-testid=terminal-hide]');
    await page.waitFor('!document.querySelector("[data-testid=terminal-drawer]")');
    await page.click('[data-testid=terminal-toggle]');
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm-rows")?.textContent.includes("git status")');
    expect(await page.evaluate(`parseFloat(getComputedStyle(document.querySelector('[data-testid=terminal-drawer]')).transitionDuration)`)).toBeLessThan(.01);
    await page.evaluate('delete document.documentElement.dataset.motion');

    await page.click("[data-testid=nav-settings]");
    await page.waitFor('document.querySelector("[data-testid=settings-tab-accounts]")');
    await page.click("[data-testid=settings-tab-accounts]");
    await page.click("[data-provider-id=opencode] [data-testid=provider-details-toggle]");
    await page.waitFor('document.querySelector("[data-provider-id=opencode] [data-testid=account-login]")');
    await page.click("[data-provider-id=opencode] [data-testid=account-login]");
    await page.waitFor('document.querySelector("[data-testid=account-login-terminal] .xterm-rows")?.textContent.includes("Select provider")');
    await page.evaluate('document.querySelector("[data-testid=account-login-terminal]").scrollIntoView({ block: "center" })');
    await settled(page);
    // The phone has no Accounts page: providers are signed in on the machine that runs them.
    await page.screenshot("tests/e2e/.artifacts/terminal-login-desktop.png");

    await page.click("[data-testid=account-login-terminal-close]");
    await page.waitFor('!document.querySelector("[data-testid=account-login-terminal]")');
    expect(page.errors()).toEqual([]);
  } finally {
    await page.close();
    await server.close();
  }
}, 90_000);
