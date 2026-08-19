import { describe, expect, it } from "vitest";
import type { CliRow } from "$lib/backend/types";
import { blocker, removable } from "./rules";
import { EN_MESSAGES } from "$lib/i18n/messages";

const row = (over: Partial<CliRow> = {}): CliRow => ({
  id: "claude",
  exe: "claude",
  installed: false,
  path: null,
  managed: false,
  version: null,
  source: "download",
  installable: true,
  requires: null,
  requiresPresent: null,
  requiresUrl: null,
  installCommand: null,
  updateCommand: null,
  uninstallCommand: null,
  dataPaths: [],
  ...over,
});

const copilot = (over: Partial<CliRow> = {}): CliRow =>
  row({
    id: "copilot",
    exe: "gh",
    source: "managed",
    requires: "gh",
    requiresUrl: "https://cli.github.com",
    installCommand: ["gh", "extension", "install", "github/gh-copilot"],
    updateCommand: ["gh", "extension", "upgrade", "gh-copilot"],
    uninstallCommand: ["gh", "extension", "remove", "gh-copilot"],
    ...over,
  });

describe("what stops a row", () => {
  it("lets a CLI Boite can fetch through", () => {
    expect(blocker(row())).toBeNull();
    expect(blocker(row({ installed: true, managed: true }))).toBeNull();
  });

  it("names the missing tool and where to get it", () => {
    // The case that started this: gh is not on the machine, so installing the
    // copilot extension is not on offer and the row says which tool is missing
    // rather than failing in a log after the click.
    const stopped = blocker(copilot({ requiresPresent: false }));
    expect(stopped).toEqual({
      key: "cli.needs",
      tool: "gh",
      url: "https://cli.github.com",
    });
    expect(blocker(copilot({ requiresPresent: true }))).toBeNull();
  });

  it("says a vendor has no build for this platform", () => {
    expect(blocker(row({ installable: false }))?.key).toBe("cli.noBuild");
  });

  it("says an agent installs itself", () => {
    expect(blocker(row({ source: "manual", installable: false }))?.key).toBe("cli.manualOnly");
  });

  it("names keys the dictionary actually has, since the row prints them", () => {
    for (const candidate of [
      row({ source: "manual", installable: false }),
      row({ installable: false }),
      copilot({ requiresPresent: false }),
    ]) {
      const stopped = blocker(candidate);
      expect(stopped).not.toBeNull();
      expect(EN_MESSAGES[stopped!.key]).toBeTruthy();
    }
  });
});

describe("what may be removed", () => {
  it("offers nothing for a CLI that is not there", () => {
    expect(removable(row())).toBe(false);
    expect(removable(copilot({ installed: false, requiresPresent: true }))).toBe(false);
  });

  it("offers what Boite installed, always", () => {
    expect(removable(row({ installed: true, managed: true }))).toBe(true);
  });

  it("holds back an extension whose host tool has gone", () => {
    // Offering it would run `gh extension remove` against a gh that is not there.
    expect(removable(copilot({ installed: true, requiresPresent: false }))).toBe(false);
    expect(removable(copilot({ installed: true, requiresPresent: true }))).toBe(true);
  });

  it("still offers a CLI installed by somebody else, for its data", () => {
    // The binary is not Boite's to take back and the dialog says so, but the data
    // is still the user's to delete.
    expect(removable(row({ installed: true, managed: false, path: "/usr/local/bin/claude" }))).toBe(
      true,
    );
    expect(removable(row({ installed: true, source: "manual" }))).toBe(false);
  });
});
