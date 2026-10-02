import { expect, test } from "bun:test";
import { connect } from "../../packages/core/src/client.ts";
import { BrowserPage, freePort } from "./lib/cdp";
import { pairingUrlOf, startCore } from "./lib/core";
import { startUi } from "./lib/ui";

async function settled(page: BrowserPage): Promise<void> {
  await page.evaluate("document.fonts.ready");
  // ResizeObserver updates the drawer after the new viewport has been laid out.
  await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await page.evaluate(
    `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
  );
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
      // Observe the frame as it opens, before the lazy terminal can finish loading.
      globalThis.__terminalUnfold = new Promise(resolve => {
        const opening = event => {
          if (event.propertyName !== 'height' || event.target.dataset.testid !== 'terminal-drawer') return;
          document.removeEventListener('transitionrun', opening, true);
          const drawer = event.target;
          const transition = drawer.getAnimations().find(animation => animation.transitionProperty === 'height');
          transition.pause();
          transition.currentTime = 150;
          resolve();
        };
        document.addEventListener('transitionrun', opening, true);
      });
    })()`);
    // A cold chunk can arrive after the one-second frame transition has ended.
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 1_400, downloadThroughput: -1, uploadThroughput: -1 });
    await chord(page, "j", "KeyJ", 74);
    await page.evaluate('globalThis.__terminalUnfold');
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm")');
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
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
    // Ctrl and a letter is the shell's inside the terminal, the palette's key included.
    await chord(page, "k", "KeyK", 75);
    // A chord no shell can read still reaches the app: Ctrl+, opens the settings.
    await chord(page, ",", "Comma", 188);
    await page.waitFor('document.querySelector("[data-testid=settings]")');
    expect(await page.evaluate('document.querySelector("[data-testid=palette]") === null')).toBe(true);
    await page.click("[data-testid=settings-back]");
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm-rows")?.textContent.includes("git status")');
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

test("switching Stores with colliding terminal ids restores the owning screen and routes its keystrokes", async () => {
  const port = await freePort();
  const server = await startUi(port);
  const page = await BrowserPage.launch({
    url: `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`,
    windowSize: { width: 1440, height: 900 },
  });
  try {
    await page.waitFor('globalThis.__boiteTest?.workspace.machines.length === 2 && globalThis.__boiteTest.workspace.machines.every(machine => machine.store.connection === "ready")');
    await page.evaluate(`(() => {
      const workspace = globalThis.__boiteTest.workspace;
      globalThis.__terminalOwners = workspace.machines.map(machine => machine.store);
      globalThis.__terminalWrites = [[], []];
      globalThis.__terminalOwners.forEach((store, index) => {
        const call = store.client.call.bind(store.client);
        store.client.call = (method, params) => {
          if (method === 'terminals.write') globalThis.__terminalWrites[index].push(params.data);
          return call(method, params);
        };
      });
      document.documentElement.dataset.motion = 'reduced';
    })()`);
    expect(await page.evaluate('globalThis.__terminalOwners.map(store => store.endpointUrl)')).toEqual([null, null]);

    // Both public fake machines retain the same thread id and keep their own shell.
    for (let owner = 0; owner < 2; owner++) {
      await page.evaluate(`globalThis.__boiteTest.workspace.select(globalThis.__terminalOwners[${owner}], 't-trace')`);
      await page.click('[data-testid=terminal-toggle]');
      await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm-rows")?.textContent.includes("PS ")');
      await settled(page);
      await page.evaluate(`document.querySelector('[data-testid=terminal-drawer] .terminal-screen').dataset.owner = '${owner}'`);
    }

    for (const [owner, text] of [[0, 'first-owner'], [1, 'second-owner']] as const) {
      await page.evaluate(`globalThis.__boiteTest.workspace.select(globalThis.__terminalOwners[${owner}], 't-trace')`);
      await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm-helper-textarea")');
      await settled(page);
      await page.evaluate(`(() => {
        globalThis.__terminalWrites = [[], []];
        document.querySelector('[data-testid=terminal-drawer] .xterm-helper-textarea').focus();
      })()`);
      await page.send('Input.insertText', { text });
      await page.waitFor(`globalThis.__terminalWrites.some(writes => writes.join('').includes('${text}'))`);
      expect(await page.evaluate('globalThis.__terminalWrites.map(writes => writes.join(""))')).toEqual(owner === 0 ? [text, ''] : ['', text]);
      expect(await page.evaluate('document.querySelector("[data-testid=terminal-drawer] .terminal-screen").dataset.owner')).toBe(String(owner));
    }
    expect(page.errors()).toEqual([]);
  } finally {
    await page.close();
    await server.close();
  }
}, 90_000);

async function press(page: BrowserPage, key: string, code: string, keyCode: number, text?: string): Promise<void> {
  const base = { key, code, windowsVirtualKeyCode: keyCode, ...(text === undefined ? {} : { text }) };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

const screenText = 'document.querySelector("[data-testid=terminal-drawer] .xterm-rows")?.innerText ?? ""';

// bash, for its line editing: Windows has none to start, and the fake shell above covers its drawer.
test.skipIf(process.platform === "win32")("a real shell keeps its screen while hidden, takes Ctrl+K and Ctrl+C, and a redraw types nothing into it", async () => {
  const core = await startCore({ env: { BOITE_TERMINAL_SHELL: "/bin/bash", HISTFILE: "/dev/null", PS1: "sh> " } });
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    const project = await client.call("projects.add", { path: core.dataDir, name: "Documents" });
    const account = (await client.call("accounts.list", {})).find((a) => a.providerId === "echo")!;
    const thread = await client.call("threads.create", { projectId: project.id, providerId: "echo", accountId: account.id, title: "Shell" });
    page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1440, height: 900 } });
    const openShell = async () => {
      await page!.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
      await page!.click(`[data-thread-id="${thread.id}"]`);
      await page!.waitFor('document.querySelector("[data-testid=thread-header][data-status]")');
      await chord(page!, "j", "KeyJ", 74);
      await page!.waitFor('document.activeElement?.classList.contains("xterm-helper-textarea")');
      await page!.waitFor(`(${screenText}).includes("$ ")`);
    };
    await openShell();

    // Ctrl+K cuts the line at the cursor in bash. It used to open the palette instead.
    await page.send("Input.insertText", { text: "echo keptCUT" });
    for (let i = 0; i < 3; i++) await press(page, "ArrowLeft", "ArrowLeft", 37);
    await chord(page, "k", "KeyK", 75);
    await press(page, "Enter", "Enter", 13, "\r");
    await page.waitFor(`(${screenText}).split("\\n").includes("kept")`);
    expect(await page.evaluate('document.querySelector("[data-testid=palette]") === null')).toBe(true);

    // A program that asks the terminal what it is, as vim, htop and an agent CLI do at start.
    // xterm answers once; the tty echoes the answer, which is what is counted below.
    await page.send("Input.insertText", { text: "printf '\\033[c'; cat -v" });
    await press(page, "Enter", "Enter", 13, "\r");
    const answers = `(${screenText}).split("^[[?1;2c").length - 1`;
    await page.waitFor(`${answers} === 1`);

    // Hidden, the screen is kept rather than rebuilt, and the keyboard goes back to the composer.
    await page.evaluate('document.querySelector("[data-testid=terminal-drawer] .terminal-screen").dataset.kept = "1"');
    await chord(page, "j", "KeyJ", 74);
    await page.waitFor('!document.querySelector("[data-testid=terminal-drawer]")');
    expect(await page.evaluate('document.activeElement?.dataset.testid')).toBe("composer-input");
    await chord(page, "j", "KeyJ", 74);
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .terminal-screen")?.dataset.kept === "1"');
    await page.waitFor('document.activeElement?.classList.contains("xterm-helper-textarea")');
    await settled(page);
    await page.screenshot("tests/e2e/.artifacts/terminal-real-desktop.png");

    // A reload redraws the screen from the core's snapshot, with the question in it.
    // Answering it again typed `1;2c` into whatever was running, on every reopen.
    await page.reload();
    await openShell();
    await page.waitFor(`${answers} === 1`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await page.evaluate(answers)).toBe(1);

    // Ctrl+C with nothing selected interrupts: cat ends and the prompt is back.
    await chord(page, "c", "KeyC", 67);
    await page.waitFor(`(${screenText}).trimEnd().endsWith("$")`);
    expect(page.errors()).toEqual([]);
  } finally {
    await page?.close();
    client.close();
    await core.stop();
  }
}, 90_000);
