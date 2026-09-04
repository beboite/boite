/**
 * A chat thread, from the launcher to the answer, and the request in the middle.
 *
 * The driver is the fake claude in `crates/boite-pilot/tests/fake-claude.mjs`,
 * pointed at `e2e/fixtures/e2e.json` by the two environment variables the
 * client stamps into the window. So this is the real stream-json wire, the real
 * runtime, the real projection and the real rows: only the model on the far end
 * is a stand-in, which is what makes the scenario worth running on every
 * change.
 *
 * The window is shared, so this file leaves two chat threads behind. `resume`
 * reads the first of them back after a restart and `dock` reads the second.
 */

import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { app, completeSetup, enableChatExperiment, openChat, sendChat } from "./lib/harness";
import type { DevApp } from "./lib/devApp";
import { sleep } from "./lib/devApp";

let dev: DevApp;
let thread = "";

/** This file's own pane, which is not the only place a card is drawn. */
const pane = () => `[data-testid='chat-pane'][data-thread='${thread}']`;

beforeAll(async () => {
  dev = await app();
  await completeSetup(dev);
  await enableChatExperiment(dev);
}, 180_000);

describe("chat", () => {
  it("opens a chat thread on claude from the launcher", async () => {
    thread = await openChat(dev, "Claude");
    expect(thread).toMatch(/^[0-9a-f-]{36}$/);
    const session = await dev.js<string | null>(`
      const el = document.querySelector("[data-testid='chat-session']");
      return el ? el.getAttribute("data-session") : null;
    `);
    expect(session).toBeTruthy();
  });

  it("answers a message, with the tokens under the turn", async () => {
    await sendChat(dev, "hello", thread);
    // "ok" is what the fixture's `hello` step streams, two deltas at a time,
    // which is also what `plain.json` replays in the wire tests.
    await dev.waitForText(
      () => dev.js<string>("return document.body.innerText || ''"),
      (text) => text.includes("ok"),
      60_000,
    );
    const footer = await dev.waitForText(
      () =>
        dev.js<string>(`
          const el = document.querySelector("[data-testid='pilot-turn-tokens']");
          return el ? el.innerText : "";
        `),
      (text) => text.length > 0,
      60_000,
    );
    expect(footer).toContain("7");
    expect(footer).toContain("4");
  });

  it("opens a request card with the driver's own three options", async () => {
    await sendChat(dev, "run it", thread);
    await dev.waitFor(
      `return !!document.querySelector("${pane()} [data-testid='pilot-request'][data-outcome='']")`,
      60_000,
    );
    // This pane's card, not every card on screen. The dock draws the same
    // question the moment it is opened, so an unscoped query reads the two of
    // them and finds six options where the driver offered three. It read three
    // only while the dock was blind to a chat thread's request, which is one of
    // the defects `dock.e2e.ts` was written against.
    const options = await dev.js<{ value: string; label: string }[]>(`
      return Array.from(document.querySelectorAll(
        "${pane()} [data-testid='pilot-request-option']"))
        .map((b) => ({ value: b.getAttribute("data-value"), label: b.textContent.trim() }));
    `);
    // The driver's order, not one this window chose: `permission_suggestions`
    // is what puts "Always allow" beside the two boite always understands.
    expect(options.map((o) => o.value).sort()).toEqual(["allow", "allow_always", "deny"]);
  });

  it("resolves the request on Allow, and says so on the card", async () => {
    await dev.js<unknown>(`
      const button = Array.from(document.querySelectorAll(
        "${pane()} [data-testid='pilot-request-option']"))
        .find((b) => b.getAttribute("data-value") === "allow");
      if (!button) throw new Error("no Allow on this card");
      button.click();
      return true;
    `);
    await dev.waitFor(
      `return !!document.querySelector("${pane()} [data-testid='pilot-request'][data-outcome='allowed']")`,
      60_000,
    );
    const answered = await dev.js<string>(`
      const el = document.querySelector("${pane()} [data-testid='pilot-request-answered']");
      return el ? el.innerText : "";
    `);
    expect(answered.toLowerCase()).toContain("allowed");
  });

  it("wrote the rows the timeline is drawn from", async () => {
    const rows = await dev.db(
      `SELECT kind, state FROM pilot_items WHERE thread_id = '${thread}' ORDER BY seq`,
    );
    expect(rows).toContain("assistant_text");
    expect(rows).toContain("request");
    expect(rows).toContain("allowed");
    expect(rows).toContain("turn");
  });

  it("logged pilot.event records carrying the thread id", async () => {
    const records = await dev.logs({ level: "debug", limit: 400, since: dev.startedAtMs });
    expect(records).toContain("pilot.event");
    expect(records).toContain(thread);
  });

  /**
   * A picture of the window with the answered turn in it.
   *
   * `BOITE_E2E_SHOT` names where, so a run started by hand can put it somewhere
   * a person will look; a plain `bun run e2e` drops it in the temp directory
   * and the path is printed rather than asserted on.
   */
  it("can be photographed", async () => {
    const target =
      process.env.BOITE_E2E_SHOT ?? path.join(tmpdir(), "boite-e2e-chat.png");
    await dev.screenshot(target);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).size).toBeGreaterThan(1000);
    console.log(`[e2e] chat screenshot: ${target} (${statSync(target).size} bytes)`);
  });

  it("opens a second thread, for the dock to find a request in", async () => {
    const second = await openChat(dev, "Claude");
    expect(second).not.toBe(thread);
    await sleep(500);
  });
});
