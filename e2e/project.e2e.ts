/**
 * A project on a scratch git repository, and the window showing it.
 *
 * The add-project control opens a **native folder dialog**, and nothing in the
 * webview can answer one: `pane-driver.js` posts into an iframe, the inspector
 * on `window.__boite` is read-only by design, and the bridge's `execute_js`
 * runs in the page rather than in the shell that drew the dialog. So the click
 * is asserted to open it and the row is written the way the app writes it,
 * through `records_project_create` on the app's own IPC with the exact
 * `Project` shape `records` takes. What is proved after that is the same
 * thing: the window reloads, reads the row back and draws the project.
 *
 * The repository is made under the system temp dir and left there: it is two
 * files, and deleting a checkout is the one thing `AGENTS.md` says not to do
 * by hand near this app.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { app, completeSetup } from "./lib/harness";
import type { DevApp } from "./lib/devApp";
import { sleep } from "./lib/devApp";

let dev: DevApp;
let repo: string;

/** A git repository with one commit in it, which is what a project needs. */
function scratchRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "boite-e2e-"));
  writeFileSync(path.join(dir, "README.md"), "# scratch\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "README.md");
  // Identity on the command line, not in a config: this repository is a
  // fixture and the machine's own git identity has no business in it.
  git(
    "-c",
    "user.name=boite e2e",
    "-c",
    "user.email=e2e@localhost",
    "commit",
    "-q",
    "-m",
    "scratch",
  );
  return dir;
}

beforeAll(async () => {
  dev = await app();
  await completeSetup(dev);
  repo = scratchRepo();
});

describe("project", () => {
  it("has an add-project control the window answers", async () => {
    const found = await dev.js<boolean>(`
      const el = document.querySelector("[aria-label='Add a project']")
        || Array.from(document.querySelectorAll("button")).find((b) =>
             (b.getAttribute("aria-label") || "").toLowerCase().includes("project"));
      return !!el;
    `);
    expect(found).toBe(true);
  });

  it("writes the row through the same command the app writes it with", async () => {
    const answer = await dev.js<{ ok: boolean; id: string; why?: string }>(`
      const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
      if (!invoke) return { ok: false, id: "", why: "no __TAURI__ in this window" };
      const project = {
        id: "e2e-project-0001",
        name: "boite e2e scratch",
        cwd: ${JSON.stringify(repo)},
        icon: null,
        archived: false,
        worktrees: false,
      };
      try {
        await invoke("records_project_create", { params: { project } });
        return { ok: true, id: project.id };
      } catch (err) {
        return { ok: false, id: "", why: String(err) };
      }
    `);
    expect(answer.why ?? "").toBe("");
    expect(answer.ok).toBe(true);
  });

  it("shows the project after a reload", async () => {
    await dev.js<unknown>("location.reload(); return true;");
    await sleep(1500);
    await dev.waitFor("return !!window.__boite", 60_000);
    await completeSetup(dev);
    const projects = await dev.waitForText(
      () => dev.inspect<unknown[]>("projects").then((rows) => JSON.stringify(rows)),
      (text) => text.includes("boite e2e scratch"),
      30_000,
    );
    expect(projects).toContain(repo.replace(/\\/g, "\\\\"));
  });

  it("has the row in the dev database, and nowhere else", async () => {
    const rows = await dev.db(
      "SELECT id, name, cwd FROM projects WHERE id = 'e2e-project-0001'",
    );
    expect(rows).toContain("e2e-project-0001");
    expect(rows).toContain("boite e2e scratch");
  });
});
