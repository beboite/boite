import { expect, test } from "bun:test";
import { join } from "node:path";
import { connect } from "../../packages/core/src/client.ts";
import { BrowserPage } from "./lib/cdp";
import { pairingUrlOf, startCore } from "./lib/core";
import { ensureProductionUi } from "./lib/prod-ui.ts";

const fixture = join(import.meta.dir, "fixtures", "ansi-screen.ts");
const phone = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
const screenText = 'document.querySelector("[data-testid=terminal-drawer] .xterm-rows")?.innerText ?? ""';

async function settled(page: BrowserPage): Promise<void> {
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await page.evaluate(
    `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
  );
  // The resize RPC follows the fit by 80 ms, and the program redraws after it.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function chord(page: BrowserPage, key: string, code: string, keyCode: number, modifiers = 2): Promise<void> {
  const base = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function run(page: BrowserPage, line: string): Promise<void> {
  await page.send("Input.insertText", { text: line });
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

/** A shell nothing of the user's reads: cmd keeps no history, sh is told to keep none. */
const shellEnv: Record<string, string> =
  process.platform === "win32" ? { BOITE_TERMINAL_SHELL: "cmd.exe" } : { BOITE_TERMINAL_SHELL: "/bin/sh", HISTFILE: "/dev/null", PS1: "$ " };
const quote = (path: string) => (process.platform === "win32" ? `"${path}"` : `'${path}'`);

test("a real shell draws ANSI colours and a full-screen program edge to edge, and keeps its tabs and splits, on desktop and phone", async () => {
  ensureProductionUi();
  const core = await startCore({ env: shellEnv });
  const client = await connect(core.url, core.token);
  let page: BrowserPage | undefined;
  try {
    // A busy host puts the memory guard in its critical state, and it would end the shell under test.
    await client.call("settings.set", { memoryProtection: false });
    const project = await client.call("projects.add", { path: core.dataDir, name: "Documents" });
    const account = (await client.call("accounts.list", {})).find((a) => a.providerId === "echo")!;
    const thread = await client.call("threads.create", { projectId: project.id, providerId: "echo", accountId: account.id, title: "Shell" });
    page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1440, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
    await page.click(`[data-thread-id="${thread.id}"]`);
    await page.waitFor('document.querySelector("[data-testid=thread-header][data-status]")');
    await chord(page, "j", "KeyJ", 74);
    await page.waitFor('document.activeElement?.classList.contains("xterm-helper-textarea")');
    await page.waitFor(`(${screenText}).includes(">") || (${screenText}).includes("$ ")`);

    const bun = quote(process.execPath);
    await run(page, `${bun} ${quote(fixture)} palette`);
    await page.waitFor(`(${screenText}).includes("hyperlink")`, 30_000);
    await settled(page);
    await page.screenshot("tests/e2e/.artifacts/terminal-render-palette-desktop.png");
    await page.evaluate("document.documentElement.dataset.theme = 'light'");
    await settled(page);
    await page.screenshot("tests/e2e/.artifacts/terminal-render-palette-light.png");
    await page.evaluate("delete document.documentElement.dataset.theme");

    await run(page, `${bun} ${quote(fixture)} fullscreen`);
    await page.waitFor(`(${screenText}).includes("ansi-screen")`, 30_000);
    await settled(page);
    // The program draws at the size the pty reports: the same as the screen xterm shows.
    const size = await page.evaluate<{ title: string; cols: number; rows: number; overflow: boolean }>(`(() => {
      const rows = document.querySelector('[data-testid=terminal-drawer] .xterm-rows');
      const screen = document.querySelector('[data-testid=terminal-drawer] .xterm-screen');
      const viewport = document.querySelector('[data-testid=terminal-drawer] .xterm-viewport');
      const host = document.querySelector('[data-testid=terminal-drawer] [data-testid=terminal]');
      return {
        title: rows.innerText.split('\\n')[0].trim(),
        cols: Number(getComputedStyle(screen).width.replace('px', '')),
        rows: rows.children.length,
        overflow: screen.getBoundingClientRect().right > host.getBoundingClientRect().right + 1 ||
          screen.getBoundingClientRect().bottom > host.getBoundingClientRect().bottom + 1 ||
          viewport.scrollHeight > viewport.clientHeight + 1,
      };
    })()`);
    expect(size.title).toContain(`x${size.rows}`);
    expect(size.overflow).toBe(false);
    await page.screenshot("tests/e2e/.artifacts/terminal-render-fullscreen-desktop.png");

    // Mouse reports reach the program: a click in its frame comes back as cells. Windows'
    // own ConPTY keeps a program's mouse modes to itself, so xterm never reports there.
    if (process.platform !== "win32") {
      const box = await page.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('[data-testid=terminal-drawer] .xterm-screen').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      await page.waitFor(`(${screenText}).includes("mouse: click")`);
    }
    // In a full-screen program Ctrl+D is the program's, not a split: it reads the byte.
    await chord(page, "d", "KeyD", 68);
    await page.waitFor(`(${screenText}).includes("key: ctrl-d")`);
    expect(await page.evaluate("document.querySelectorAll('[data-testid=terminal-pane]').length")).toBe(1);

    await page.send("Emulation.setDeviceMetricsOverride", phone);
    await settled(page);
    // The program was told the phone's size and drew itself again at it.
    const phoneTitle = await page.evaluate<string>(`(${screenText}).split('\\n')[0]`);
    const phoneRows = await page.evaluate<number>("document.querySelector('[data-testid=terminal-drawer] .xterm-rows').children.length");
    expect(phoneTitle).toContain(`x${phoneRows}`);
    expect(phoneTitle).not.toContain(size.title.replace("ansi-screen", "").trim());
    await page.screenshot("tests/e2e/.artifacts/terminal-render-fullscreen-phone.png");
    await page.send("Input.insertText", { text: "q" });
    await page.waitFor(`!/ansi-screen \\d+x\\d+/.test(${screenText})`);
    await settled(page);
    await page.screenshot("tests/e2e/.artifacts/terminal-render-palette-phone.png");
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    await settled(page);

    // T3 Code's chords: Ctrl+D splits the shell, Ctrl+N opens one in a new tab.
    await chord(page, "d", "KeyD", 68);
    await page.waitFor("document.querySelectorAll('[data-testid=terminal-pane]').length === 2");
    await page.waitFor(`document.activeElement?.closest('[data-terminal-id="terminal:${thread.id}:term-2"]') != null`);
    await run(page, "echo second-shell");
    await page.waitFor(`[...document.querySelectorAll('[data-testid=terminal-pane]')].some(p => p.innerText.includes('second-shell'))`);
    await settled(page);
    await page.screenshot("tests/e2e/.artifacts/terminal-render-split-desktop.png");
    await chord(page, "n", "KeyN", 78);
    await page.waitFor("document.querySelectorAll('[data-testid=terminal-tab]').length === 2");
    await page.waitFor(`document.activeElement?.closest('[data-terminal-id="terminal:${thread.id}:term-3"]') != null`);
    expect(await client.call("terminals.list", { threadId: thread.id })).toHaveLength(3);

    // A reload finds the same tabs, the split and what each shell printed.
    await page.reload();
    await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
    await page.click(`[data-thread-id="${thread.id}"]`);
    await page.waitFor("document.querySelectorAll('[data-testid=terminal-tab]').length === 2");
    await page.click("[data-testid=terminal-tab] [role=tab]");
    await page.waitFor("document.querySelectorAll('[data-testid=terminal-pane]').length === 2");
    await page.waitFor(`[...document.querySelectorAll('[data-testid=terminal-pane]')].some(p => p.innerText.includes('second-shell'))`);
    await page.waitFor(`[...document.querySelectorAll('[data-testid=terminal-pane]')].some(p => p.innerText.includes('hyperlink'))`);
    await settled(page);
    await page.screenshot("tests/e2e/.artifacts/terminal-render-reloaded-desktop.png");

    // A phone never shows a split: each shell is a tab of its own.
    await page.send("Emulation.setDeviceMetricsOverride", phone);
    await settled(page);
    expect(await page.evaluate("document.querySelectorAll('[data-testid=terminal-tab]').length")).toBe(3);
    expect(await page.evaluate("document.querySelectorAll('[data-testid=terminal-pane]').length")).toBe(1);
    await page.screenshot("tests/e2e/.artifacts/terminal-render-tabs-phone.png");

    // Appearance picks the cursor's shape, and a running screen takes it.
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    // A hidden window never has the focus, and xterm draws an unfocused cursor as an outline.
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.click("[data-testid=nav-settings]");
    await page.click("[data-testid=settings-tab-appearance]");
    await page.click("[data-testid=terminal-cursor-block]");
    await page.click("[data-testid=settings-back]");
    await page.click("[data-testid=terminal-drawer] .xterm-screen");
    await page.waitFor("document.querySelector('[data-testid=terminal-drawer] .xterm-cursor-block') !== null");
    await page.evaluate("localStorage.removeItem('boite.terminalCursor')");
    expect(page.errors()).toEqual([]);
  } finally {
    await page?.close();
    client.close();
    await core.stop();
  }
}, 180_000);
