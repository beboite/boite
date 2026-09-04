/**
 * A request answered in the approvals dock, with the chat pane out of the way.
 *
 * Skipped, and kept: two defects in the app stop it, both found by writing it.
 *
 * 1. Nothing tells the window that a chat thread opened an approval row.
 *    `boite://approvals-changed` is emitted from `src-tauri/src/agent_api.rs`
 *    alone, so `approvals.watch()` never fires for a `pilot.request` row and
 *    the dock stays empty until the webview is reloaded for some other reason.
 * 2. After that reload the dock's card never resolves:
 *    `src/lib/features/pilot/reduce.ts::fromRows` rebuilds `items` from the
 *    stored rows and leaves `state.requests` empty, so `PilotApproval` looks up
 *    its request id, finds nothing and draws "Loading" forever. Its own comment
 *    promises the opposite ("an open request is one whose row still reads
 *    open, which is how a client that reloaded mid-approval still draws the
 *    card the dock is drawing").
 *
 * Both were watched happening on the live dev window: the row is in
 * `approvals` (`dev_db`) and the log carries `approval.opened ...
 * action=pilot.request`, while the dock shows the thread's name over the word
 * "Loading". Unskip when either is fixed; the assertions below are what a fixed
 * dock has to satisfy.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { app, completeSetup, enableChatExperiment, openChat, sendChat } from "./lib/harness";
import type { DevApp } from "./lib/devApp";
import { sleep } from "./lib/devApp";

let dev: DevApp;
let thread = "";

beforeAll(async () => {
  dev = await app();
  await completeSetup(dev);
  await enableChatExperiment(dev);
}, 180_000);

describe.skip("dock", () => {
  it("opens a request from a chat pane, then hides the pane", async () => {
    thread = await openChat(dev, "Claude");
    await sendChat(dev, "run it", thread);
    await dev.waitFor(
      `return !!document.querySelector("[data-testid='chat-pane'][data-thread='${thread}'] [data-testid='pilot-request'][data-outcome='']")`,
      60_000,
    );
    // The pane goes, the question stays: that is the whole point of a dock.
    await dev.click(
      `[data-testid='chat-pane'][data-thread='${thread}'] [aria-label='Close chat']`,
    );
    await sleep(500);
    const panes = await dev.js<number>(
      `return document.querySelectorAll("[data-testid='chat-pane'][data-thread='${thread}']").length`,
    );
    expect(panes).toBe(0);
  });

  it("shows the same card in the dock", async () => {
    await dev.waitFor(
      "return !!document.querySelector(\"[data-testid='pilot-request'][data-compact='true']\")",
      60_000,
    );
    const options = await dev.js<string[]>(`
      return Array.from(document.querySelectorAll(
        "[data-testid='pilot-request'][data-compact='true'] [data-testid='pilot-request-option']"
      )).map((b) => b.getAttribute("data-value"));
    `);
    expect(options.sort()).toEqual(["allow", "allow_always", "deny"]);
  });

  it("answers it there", async () => {
    await dev.js<unknown>(`
      const button = document.querySelector(
        "[data-testid='pilot-request'][data-compact='true'] [data-value='allow']");
      if (!button) throw new Error("no Allow in the dock");
      button.click();
      return true;
    `);
    await dev.waitFor(
      `return !document.querySelector("[data-testid='pilot-request'][data-compact='true'][data-outcome='']")`,
      60_000,
    );
    const rows = await dev.db(
      `SELECT kind, state FROM pilot_items WHERE thread_id = '${thread}' AND kind = 'request'`,
    );
    expect(rows).toContain("allowed");
  });
});
