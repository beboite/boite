/**
 * A request answered in the approvals dock, with the chat pane out of the way.
 *
 * Written while both halves of that were broken, and it is what proves they are
 * not any more.
 *
 * 1. Nothing told the window that a chat thread had opened an approval row.
 *    `boite://approvals-changed` came from `src-tauri/src/agent_api.rs` alone,
 *    so `approvals.watch()` never fired for a `pilot.request` row and the dock
 *    stayed empty until the webview reloaded for some other reason. Both hosts
 *    now emit it off the projection that writes the row.
 * 2. The card then never resolved: `fromRows` rebuilt `items` and left
 *    `state.requests` empty, so `PilotApproval` looked its request id up, found
 *    nothing and drew "Loading". The list is rebuilt from the request rows,
 *    which is what its own comment promised.
 *
 * The three cases are one story and run in order: the pane opens the question
 * and goes away, the dock draws the same card, and the answer given there is
 * the answer on the row.
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

describe("dock", () => {
  it("opens a request from a chat pane, then hides the pane", async () => {
    thread = await openChat(dev, "Claude");
    await sendChat(dev, "run it", thread);
    await dev.waitFor(
      `return !!document.querySelector("[data-testid='chat-pane'][data-thread='${thread}'] [data-testid='pilot-request'][data-outcome='']")`,
      60_000,
    );
    // The pane goes, the question stays: that is the whole point of a dock.
    // `pilot.close` is what the header's button is labelled, in English
    // "Close the pane"; the scenario was written against a "Close chat" that
    // never existed and could only ever have refused.
    await dev.click(
      `[data-testid='chat-pane'][data-thread='${thread}'] [aria-label='Close the pane']`,
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
