import { describe, expect, it } from "vitest";
import { spawnFailure, spawnFailureKey, spawnPillKey } from "./spawn-error";

describe("spawnFailure", () => {
  it("recognises the pty's own refusal", () => {
    expect(
      spawnFailure("this directory is not there: C:\\Dev\\gone"),
    ).toBe("folderGone");
  });

  it("recognises a missing binary", () => {
    expect(spawnFailure("claude: command not found")).toBe("notFound");
  });

  it("recognises a refusal", () => {
    expect(spawnFailure("Access is denied. (os error 5)")).toBe("denied");
  });

  it("says nothing about anything else", () => {
    expect(spawnFailure("the conpty could not be opened")).toBe("unknown");
  });
});

describe("what the user reads", () => {
  it("points a gone folder at the dashboard, in both places", () => {
    expect(spawnFailureKey("folderGone")).toBe("terminal.spawnFolderGone");
    expect(spawnPillKey("folderGone")).toBe("terminal.spawnFolderGonePill");
  });

  it("leaves every other failure on the relaunch pill", () => {
    expect(spawnPillKey("unknown")).toBe("terminal.spawnFailedRelaunch");
    expect(spawnPillKey("notFound")).toBe("terminal.spawnFailedRelaunch");
    expect(spawnFailureKey("unknown")).toBe("terminal.spawnFailedLine");
  });
});
