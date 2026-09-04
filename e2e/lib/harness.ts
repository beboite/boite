/**
 * The one dev window the whole run shares, and the waits every scenario needs.
 *
 * Started once and stopped once. The shim that owns the window has to be a
 * child of the process issuing `dev_window`, because `stop` and `restart` act
 * on the pid that shim captured at spawn and on nothing else: a second shim
 * asked to restart would spawn a second window beside the first rather than
 * replacing it. So the start lives in a setup file that runs inside the test
 * worker, with the run pinned to one worker, rather than in vitest's own
 * `globalSetup`, which is a different process. The stop is registered on the
 * worker's exit, and the job object behind the shim is the second half of it.
 */

import { DevApp, sleep } from "./devApp";

const KEY = "__boiteE2eApp";
const STARTED = "__boiteE2eStarted";

interface Holder {
  [KEY]?: DevApp;
  [STARTED]?: Promise<void>;
}

/** The client, with the window up. Idempotent: every file calls it. */
export async function app(): Promise<DevApp> {
  const holder = globalThis as unknown as Holder;
  const client = (holder[KEY] ??= new DevApp());
  holder[STARTED] ??= (async () => {
    // Fresh, so every run starts from an empty dev database and a scenario
    // never reads a row the one before it wrote.
    await client.start({ fresh: true });
    await settleWindow(client);
  })();
  await holder[STARTED];
  return client;
}

/** Stop the window. Called from the setup file's own teardown. */
export async function stopApp(): Promise<void> {
  const holder = globalThis as unknown as Holder;
  const client = holder[KEY];
  if (!client) return;
  holder[KEY] = undefined;
  holder[STARTED] = undefined;
  await client.stop();
}

/**
 * Wait until the window has painted something the scenarios can act on.
 *
 * `dev_window start` returns when the bridge accepts a connection, which is
 * earlier than the first frame: the webview is up, the app's own boot is not.
 */
export async function settleWindow(client: DevApp): Promise<void> {
  await client.waitFor("return document.body && document.body.childElementCount > 0", 60_000);
  await client.waitFor("return !!window.__boite", 60_000);
  await sleep(500);
}

/** The visible text of the whole window, for the assertions that read it. */
export async function pageText(client: DevApp): Promise<string> {
  return client.js<string>("return document.body.innerText || ''");
}

/** How many nodes match, which is the cheapest "is it there yet" there is. */
export async function count(client: DevApp, selector: string): Promise<number> {
  return client.js<number>(
    `return document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

/**
 * Get past the first-run wizard, and seed the shortcuts a launcher needs.
 *
 * A wiped database has `setupCompleted: false`, so the window opens on the
 * wizard rather than on the workspace. Skipping it leaves no shortcuts at all,
 * which is a launcher with no rows and therefore no Chat button, so the wizard
 * is walked rather than skipped: its agents step is what detects the CLIs and
 * writes them.
 */
export async function completeSetup(client: DevApp): Promise<void> {
  const wizard = await count(client, "[role='dialog'][aria-modal='true']");
  if (wizard === 0) return;
  // English first, on the welcome screen. The window follows the machine's
  // locale on a wiped database and this one is French, so every assertion that
  // reads a label would be reading a translation of it.
  await pickEnglish(client);
  // Welcome, then the agents step, then the telemetry step, which finishes on
  // its own choice rather than on the footer's button.
  for (let i = 0; i < 6; i++) {
    const done = await client.js<boolean>(
      "return !document.querySelector(\"[role='dialog'][aria-modal='true']\")",
    );
    if (done) break;
    await advanceWizard(client);
    await sleep(400);
  }
  await client.waitFor(
    "return !document.querySelector(\"[role='dialog'][aria-modal='true']\")",
    20_000,
  );
  await sleep(500);
}

/** The welcome screen's language row, set to English. */
async function pickEnglish(client: DevApp): Promise<void> {
  await client.js<unknown>(`
    const dialog = document.querySelector("[role='dialog'][aria-modal='true']");
    if (!dialog) return { done: true };
    const button = Array.from(dialog.querySelectorAll("button"))
      .find((b) => (b.textContent || "").trim() === "English");
    if (button) button.click();
    return { picked: !!button };
  `);
  await sleep(300);
}

/**
 * One step of the wizard.
 *
 * The telemetry step has no footer button: it finishes on the choice itself,
 * and the choice this harness makes is the anonymous one, so a test run never
 * turns enhanced telemetry on.
 */
async function advanceWizard(client: DevApp): Promise<void> {
  await client.js<unknown>(`
    const dialog = document.querySelector("[role='dialog'][aria-modal='true']");
    if (!dialog) return { done: true };
    const decline = dialog.querySelector("button.no-btn");
    if (decline) {
      decline.click();
      return { clicked: "no-btn" };
    }
    const buttons = Array.from(dialog.querySelectorAll("button"));
    const primary = buttons.find((b) => b.className.includes("bg-foreground"))
      || buttons[buttons.length - 1];
    if (primary) primary.click();
    return { clicked: primary ? primary.textContent.trim() : null };
  `);
}

/**
 * Turn the chat experiment on, and leave it on.
 *
 * Idempotent on purpose: the switch ships on in this build, so a scenario that
 * clicked it unconditionally would be the one that turned it off. The state is
 * read from `aria-checked`, which is the only thing about it the DOM promises.
 */
export async function enableChatExperiment(client: DevApp): Promise<void> {
  const already = await client.js<string | null>(`
    const el = document.querySelector("#setting-experiments-pilot");
    return el ? el.getAttribute("aria-checked") : null;
  `);
  if (already === "true") return;
  await openExperiments(client);
  const found = await client.js<boolean>(`
    const el = document.querySelector("#setting-experiments-pilot");
    if (!el) return false;
    if (el.getAttribute("aria-checked") !== "true") el.click();
    return true;
  `);
  if (!found) throw new Error("no experiments switch for chat threads in this build");
  await sleep(400);
  await closeSettings(client);
}

/**
 * The Experiments tab, open and drawn.
 *
 * Settings is a view, not a dialog: its button toggles it, so it is clicked
 * once on the way in and the close control is used on the way out. Clicked in
 * a loop because the button is in the shortcut rail, which re-renders while the
 * workspace settles, and a click on a replaced node does nothing at all. The
 * tab is a rail on a wide window and a strip on a narrow one, and which of the
 * two is drawn is not something a scenario should have to know.
 */
const EXPERIMENTS_TAB =
  "#settings-tab-rail-experiments, #settings-tab-strip-experiments";

async function openExperiments(client: DevApp): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await client.js<unknown>(`
      if (!document.querySelector("${EXPERIMENTS_TAB}")) {
        const button = document.querySelector("[aria-label='Settings']");
        if (button) button.click();
      }
      return true;
    `);
    try {
      await client.waitFor(`return !!document.querySelector("${EXPERIMENTS_TAB}")`, 8_000);
      break;
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  await client.click(EXPERIMENTS_TAB);
  await client.waitFor(
    "return !!document.querySelector('#setting-experiments-pilot')",
    20_000,
  );
}

async function closeSettings(client: DevApp): Promise<void> {
  await client.js<unknown>(`
    const close = document.querySelector("[aria-label='Close settings']");
    if (close) close.click();
    return !!close;
  `);
  await client.waitFor("return !document.querySelector('#setting-experiments-pilot')", 20_000);
  await sleep(600);
}

/**
 * Turn the workspace experiment on and point the orchestrator at claude.
 *
 * Two settings and one screen: the switch arms the Home card at all, and the
 * agent row under it only exists while the switch is on, which is why the two
 * cannot be written in one pass. Idempotent like the chat one, so a second
 * scenario asking does not turn either of them back off.
 */
export async function enableOrchestrator(client: DevApp): Promise<void> {
  await openExperiments(client);
  await client.js<unknown>(`
    const el = document.querySelector("#setting-experiments-workspace");
    if (el && el.getAttribute("aria-checked") !== "true") el.click();
    return !!el;
  `);
  await client.waitFor(
    "return !!Array.from(document.querySelectorAll(\"[role='radio']\"))" +
      ".find((b) => (b.textContent || '').trim() === 'Claude')",
    20_000,
  );
  await client.js<unknown>(`
    const button = Array.from(document.querySelectorAll("[role='radio']"))
      .find((b) => (b.textContent || "").trim() === "Claude");
    if (button && button.getAttribute("aria-checked") !== "true") button.click();
    return !!button;
  `);
  await sleep(400);
  await closeSettings(client);
}

/** Home, through the titlebar's own button, which is how a person gets there. */
export async function openHome(client: DevApp): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const there = await client.js<boolean>(
      "return !!document.querySelector(\"[data-testid='orchestrator-input']\")",
    );
    if (there) return;
    await client.js<unknown>(`
      const buttons = Array.from(document.querySelectorAll("[aria-label='Home']"));
      const button = buttons[buttons.length - 1];
      if (button) button.click();
      return !!button;
    `);
    await sleep(700);
  }
  throw new Error("Home never drew the orchestrator composer");
}

/**
 * Type a line into the Home composer and send it.
 *
 * The same prototype-setter dance `sendChat` does, for the same reason: a plain
 * assignment fills the box and not the state Svelte binds to it.
 */
export async function postFromHome(client: DevApp, line: string): Promise<void> {
  await client.js<unknown>(`
    const box = document.querySelector("[data-testid='orchestrator-input']");
    if (!box) throw new Error("no composer on Home");
    box.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(box, ${JSON.stringify(line)});
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await client.waitFor(
    "const b = document.querySelector(\"[data-testid='orchestrator-send']\");" +
      " return !!b && !b.disabled",
    10_000,
  );
  await client.click("[data-testid='orchestrator-send']");
}

/**
 * A chat thread on one driver, opened the way a person opens one.
 *
 * The launcher is a popover, so the trigger comes first, and the Chat button
 * carries no attribute naming its driver: the row it sits in holds the driver's
 * label and that is what picks it. Retried, because the popover re-renders
 * while the catalog answers and a click on a node Svelte has replaced does
 * nothing at all.
 */
export async function openChat(client: DevApp, driver = "Claude"): Promise<string> {
  const known = await client.js<string[]>(`
    return Array.from(document.querySelectorAll("[data-testid='chat-pane']"))
      .map((el) => el.getAttribute("data-thread"));
  `);
  const before = known.length;
  for (let attempt = 0; attempt < 5; attempt++) {
    await client.js<unknown>(`
      if (!document.querySelector("[aria-label='Chat']")) {
        const trigger = document.querySelector("[aria-label='Start an agent or a terminal here']");
        if (trigger) trigger.click();
      }
      return true;
    `);
    await sleep(700);
    await client.js<unknown>(`
      const wanted = ${JSON.stringify(driver)};
      const button = Array.from(document.querySelectorAll("[aria-label='Chat']"))
        .find((b) => ((b.parentElement && b.parentElement.innerText) || "").trim() === wanted);
      if (button) button.click();
      return !!button;
    `);
    try {
      await client.waitFor(
        `return document.querySelectorAll("[data-testid='chat-pane']").length > ${before}`,
        8_000,
      );
      break;
    } catch {
      if (attempt === 4) throw new Error(`no chat pane opened on ${driver}`);
    }
  }
  const opened = await client.js<string>(`
    const seen = ${JSON.stringify(known)};
    const el = Array.from(document.querySelectorAll("[data-testid='chat-pane']"))
      .find((node) => !seen.includes(node.getAttribute("data-thread")));
    return el ? el.getAttribute("data-thread") : "";
  `);
  if (!opened) throw new Error("a chat pane opened, and it names no thread");
  const pane = chatPaneSelector(opened);
  // The session, retried through the composer's own button.
  //
  // `launchChat` used to fire `pilot.open` without waiting for the row to be
  // written, so on a machine under load the open was refused with "no thread
  // <id>" and the pane came up with no session; it awaits the write now
  // (`src/lib/features/thread/api.ts`). The retry stays because the button is
  // the way back in from every other reason an open can fail, a driver that is
  // not installed included, and a scenario that could not use it would fail
  // with a timeout instead of a sentence.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await client.waitFor(
        `return !!document.querySelector("${pane} [data-testid='chat-session']")`,
        10_000,
      );
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      await client.js<unknown>(`
        const button = document.querySelector("${pane} [data-testid='chat-open-session']");
        if (button) button.click();
        return !!button;
      `);
    }
  }
  return opened;
}

/**
 * Type a line and send it.
 *
 * The value goes through the prototype's own setter followed by an `input`
 * event, which is what a bound Svelte textarea listens to; a plain assignment
 * fills the box and not the state behind it. The send button is waited on
 * rather than clicked straight away: it is disabled until that state has caught
 * up, and a click on a disabled button is silently nothing.
 */
export async function sendChat(
  client: DevApp,
  line: string,
  thread?: string,
): Promise<void> {
  const pane = chatPaneSelector(thread);
  await client.js<unknown>(`
    const box = document.querySelector("${pane} [data-testid='chat-input']");
    if (!box) throw new Error("no composer in this pane");
    box.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(box, ${JSON.stringify(line)});
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await client.waitFor(
    `const b = document.querySelector("${pane} [data-testid='chat-send']"); return !!b && !b.disabled`,
    10_000,
  );
  await client.click(`${pane} [data-testid='chat-send']`);
}

/** One pane, or whichever one is drawn, as a selector prefix. */
export function chatPaneSelector(thread?: string): string {
  return thread
    ? `[data-testid='chat-pane'][data-thread='${thread}']`
    : "[data-testid='chat-pane']";
}
