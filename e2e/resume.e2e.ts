/**
 * The thread `chat` left behind, after the window was restarted.
 *
 * Restarted rather than started fresh: the point of the scenario is that the
 * rows survive the process and that the driver is handed `--resume=<id>` with
 * the native session the last run named, so a wipe here would prove nothing.
 * The restart acts on the pid the shim captured at spawn, which is the only
 * handle on that window anything in this repo holds.
 *
 * Ordered after `chat` by filename, which is what `vitest --sequence.shuffle
 * false` and the single worker in `e2e/vitest.config.ts` guarantee.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { app, completeSetup, settleWindow } from "./lib/harness";
import { sendChat } from "./lib/harness";
import type { DevApp } from "./lib/devApp";
import { sleep } from "./lib/devApp";

let dev: DevApp;
let thread = "";
let sessionBefore = "";

beforeAll(async () => {
  dev = await app();
  await completeSetup(dev);
  // `session_id` on the row is the native session: the claude driver launches
  // with `--session-id=<thread>` and resumes with `--resume=<that>`, so the
  // column is what a restart has to hand back.
  const rows = await dev.db(
    "SELECT id, session_id FROM threads WHERE runtime = 'pilot' ORDER BY created_at LIMIT 1",
  );
  const ids = rows.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  if (ids.length === 0) throw new Error(`no chat thread to resume, rows were: ${rows}`);
  thread = ids[0];
  sessionBefore = ids[1] ?? ids[0];
  await dev.start({ restart: true });
  await settleWindow(dev);
  await completeSetup(dev);
}, 300_000);

/** Open a thread from the sidebar, which is where it is after a restart. */
async function openFromSidebar(client: DevApp, id: string): Promise<void> {
  await client.waitFor(
    `return !!document.querySelector("li[data-thread-id='${id}']")`,
    60_000,
  );
  await client.js<unknown>(`
    const row = document.querySelector("li[data-thread-id='${id}']");
    const target = row.querySelector("button") || row;
    target.click();
    return true;
  `);
  await client.waitFor(
    `return !!document.querySelector("[data-testid='chat-pane'][data-thread='${id}']")`,
    60_000,
  );
}

describe("resume", () => {
  it("still has the thread after the restart", async () => {
    const rows = await dev.db(`SELECT id, runtime FROM threads WHERE id = '${thread}'`);
    expect(rows).toContain(thread);
    expect(rows).toContain("pilot");
  });

  it("reopens the pane on the same native session", async () => {
    await openFromSidebar(dev, thread);
    // A restarted window has no child process, so the session is closed and the
    // composer is the way back in. `pilot.open` is what hands the driver
    // `--resume=<id>`, and the fake answers on the id it was resumed with.
    await dev.js<unknown>(`
      const button = document.querySelector("[data-testid='chat-open-session']");
      if (button) button.click();
      return !!button;
    `);
    const session = await dev.waitForText(
      () =>
        dev.js<string>(`
          const el = document.querySelector("[data-testid='chat-session']");
          return el ? (el.getAttribute("data-session") || "") : "";
        `),
      (text) => text.length > 0,
      120_000,
    );
    expect(session).toBe(sessionBefore);
  });

  it("answers a second turn", async () => {
    await sendChat(dev, "again");
    const text = await dev.waitForText(
      () => dev.js<string>("return document.body.innerText || ''"),
      (body) => body.includes("still here"),
      60_000,
    );
    expect(text).toContain("still here");
    await sleep(300);
  });
});
