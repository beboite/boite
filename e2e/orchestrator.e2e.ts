/**
 * The orchestrator as a chat thread, from the Home composer to the answer.
 *
 * Both experiments on, the orchestrator agent set to claude, and the driver is
 * the same fake claude every other chat scenario runs against. So what is
 * proved here is the whole path: `orchestrator.post` turning into
 * `pilot.turn.start` on the bus, the projection writing the two items, and the
 * Home card drawing them out of the pilot store rather than out of
 * `orchestrator_messages`.
 *
 * It brings its own project. Every other scenario that needs one is unnamed in
 * the sequencer and runs after this file, and an orchestrator with nowhere to
 * live is refused with a toast rather than a thread.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  app,
  completeSetup,
  enableChatExperiment,
  enableOrchestrator,
  openHome,
  postFromHome,
} from "./lib/harness";
import type { DevApp } from "./lib/devApp";
import { sleep } from "./lib/devApp";

let dev: DevApp;

/** A git repository with one commit in it, which is what a project needs. */
function scratchRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "boite-e2e-orch-"));
  writeFileSync(path.join(dir, "README.md"), "# scratch\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "README.md");
  // Identity on the command line, not in a config: this repository is a
  // fixture and the machine's own git identity has no business in it.
  git("-c", "user.name=boite e2e", "-c", "user.email=e2e@localhost", "commit", "-q", "-m", "scratch");
  return dir;
}

beforeAll(async () => {
  dev = await app();
  await completeSetup(dev);
  await enableChatExperiment(dev);
  const repo = scratchRepo();
  const made = await dev.js<{ ok: boolean; why?: string }>(`
    const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (!invoke) return { ok: false, why: "no __TAURI__ in this window" };
    const project = {
      id: "e2e-orchestrator-0001",
      name: "boite e2e orchestrator",
      cwd: ${JSON.stringify(repo)},
      icon: null,
      archived: false,
      worktrees: false,
    };
    try {
      await invoke("records_project_create", { params: { project } });
      return { ok: true };
    } catch (err) {
      return { ok: false, why: String(err) };
    }
  `);
  if (!made.ok) throw new Error(`no project for the orchestrator: ${made.why}`);
  await dev.js<unknown>("location.reload(); return true;");
  await sleep(2000);
  await dev.waitFor("return !!window.__boite", 60_000);
  await enableOrchestrator(dev);
}, 300_000);

describe("orchestrator", () => {
  it("draws the chat composer on Home", async () => {
    await openHome(dev);
    const found = await dev.js<boolean>(
      "return !!document.querySelector(\"[data-testid='orchestrator-input']\")",
    );
    expect(found).toBe(true);
  });

  it("answers a message posted from Home, on the chat runtime", async () => {
    // "hello" is the fixture's first step, the same two deltas `chat.e2e.ts`
    // reads: one scenario file, so a fake and a wire test cannot drift.
    await postFromHome(dev, "hello");
    // The timeline is what the card draws for a chat orchestrator, and the
    // testid is what says the branch was taken rather than the message list.
    await dev.waitFor(
      "return !!document.querySelector(\"[data-testid='orchestrator-chat-pilot']\")",
      120_000,
    );
    const text = await dev.waitForText(
      () =>
        dev.js<string>(`
          const el = document.querySelector("[data-testid='orchestrator-chat-pilot']");
          return el ? el.innerText : "";
        `),
      (seen) => seen.includes("hello") && seen.includes("ok"),
      120_000,
    );
    expect(text).toContain("hello");
    expect(text).toContain("ok");
  });

  it("wrote a chat row and the two items behind it, and no chat message row", async () => {
    const threads = await dev.db(
      "SELECT id, runtime FROM threads WHERE role = 'orchestrator' AND settled_at IS NULL",
    );
    expect(threads).toContain("pilot");
    const kinds = await dev.db(`
      SELECT kind FROM pilot_items WHERE thread_id IN
        (SELECT id FROM threads WHERE role = 'orchestrator' AND settled_at IS NULL)
      ORDER BY seq
    `);
    expect(kinds).toContain("user_message");
    expect(kinds).toContain("assistant_text");
    // The two paths are exclusive: a line written to both tables would be
    // drawn twice, once as an item and once as a row nothing purges.
    const rows = await dev.db("SELECT count(*) AS n FROM orchestrator_messages");
    expect(rows).toContain("0");
  });
});
