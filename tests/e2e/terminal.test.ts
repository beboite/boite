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
    await page.waitFor('document.querySelector("[data-testid=terminal-toggle]")');
    await chord(page, "j", "KeyJ", 74);
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer] .xterm-rows")?.textContent.includes("PS ")');
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
    await page.send("Emulation.clearDeviceMetricsOverride", {});

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
