import { describe, expect, it } from "vitest";
import { isGenericTitle } from "./title-filter";

describe("isGenericTitle", () => {
  it("treats brand names as generic so the user's label survives", () => {
    for (const title of ["claude", "Claude Code", "  CODEX  ", "GitHub Copilot"]) {
      expect(isGenericTitle(title), title).toBe(true);
    }
  });

  it("keeps real work titles", () => {
    expect(isGenericTitle("Fixing the PTY read loop")).toBe(false);
    expect(isGenericTitle("src/lib/app/store.svelte.ts")).toBe(false);
  });

  it("is false for empty and missing titles", () => {
    expect(isGenericTitle(null)).toBe(false);
    expect(isGenericTitle(undefined)).toBe(false);
    expect(isGenericTitle("")).toBe(false);
  });

  it("normalizes a shell executable path down to its brand name", () => {
    expect(isGenericTitle("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
    expect(isGenericTitle("/usr/bin/zsh")).toBe(true);
    expect(isGenericTitle("/bin/bash")).toBe(true);
  });

  it("strips the elevation prefix cmd.exe prepends", () => {
    expect(isGenericTitle("Administrator: C:\\Windows\\System32\\cmd.exe")).toBe(true);
  });

  it("does not treat any executable path as generic", () => {
    expect(isGenericTitle("/usr/local/bin/boite")).toBe(false);
    expect(isGenericTitle("C:\\tools\\deploy.exe")).toBe(false);
  });

  it("treats the project folder name as generic, which is codex's default", () => {
    expect(isGenericTitle("boite", "D:\\Dev\\Collab\\boite")).toBe(true);
    expect(isGenericTitle("BOITE", "/home/nuno/boite")).toBe(true);
    expect(isGenericTitle("boite", "/home/nuno/boite/")).toBe(true);
  });

  it("does not treat a different folder name as generic", () => {
    expect(isGenericTitle("boite", "/home/nuno/other")).toBe(false);
    expect(isGenericTitle("anything", "")).toBe(false);
  });

  it("stays consistent with the Rust implementation for the shared cases", () => {
    // status.rs derives the same thing server-side; a title that is generic on
    // one side and not the other renames a thread only in remote mode.
    const shared: [string, string | null][] = [
      ["claude", null],
      ["pwsh", null],
      ["cmd.exe", null],
      ["boite", "/home/nuno/boite"],
    ];
    for (const [title, cwd] of shared) {
      expect(isGenericTitle(title, cwd), title).toBe(true);
    }
  });
});
