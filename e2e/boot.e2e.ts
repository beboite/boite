/**
 * The window comes up, and says nothing went wrong on the way.
 *
 * The first scenario of the run, so it is the one that pays for the debug
 * build. Everything after it reuses the window this started.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { app, completeSetup, pageText } from "./lib/harness";
import type { DevApp } from "./lib/devApp";

let dev: DevApp;

beforeAll(async () => {
  dev = await app();
  await completeSetup(dev);
});

describe("boot", () => {
  it("is up, with the pid the tool captured at spawn", async () => {
    const status = await dev.status();
    expect(status).toContain("state: up");
    expect(status).toMatch(/pid: \d+/);
    expect(status).toContain("port: 1430");
  });

  it("answers dev_inspect overview", async () => {
    const overview = await dev.inspect<Record<string, unknown>>("overview");
    expect(overview).toBeTruthy();
    expect(Object.keys(overview).length).toBeGreaterThan(0);
    // A dev build is the only one that installs the inspector, so an overview
    // that answers is also the proof the window is the isolated one.
    expect(overview).toHaveProperty("view");
  });

  it("shows a window with something painted in it", async () => {
    const text = await pageText(dev);
    expect(text.length).toBeGreaterThan(0);
  });

  /**
   * Nothing logged at `error` since the window started, git aside.
   *
   * `since` is the start rather than the whole file: the log directory belongs
   * to `dev.boite.dev` and survives a wipe of the database, so a run would
   * otherwise fail on what the run before it logged.
   *
   * The `git` domain is excluded because a fresh install writes a Scratch
   * project on the home directory, which is not a repository, and every refresh
   * on it logs `refresh failed` at `error` a few times a minute. That is the
   * app's own default failing its own check rather than anything a scenario
   * did, so it is named here and listed as a defect rather than quietly
   * swallowed by a looser assertion.
   */
  it("logged no error record since it started", async () => {
    const records = await dev.logs({ level: "error", since: dev.startedAtMs });
    const rest = records
      .split("\n")
      .filter((line) => line.includes("error") && !line.includes("git"));
    expect(rest.join("\n")).toBe("");
  });
});
