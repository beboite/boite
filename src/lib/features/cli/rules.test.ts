import { describe, expect, it } from "vitest";
import type { CliRow } from "$lib/backend/types";
import { action, blocker, removable, upToDate } from "./rules";
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
  unlinked: null,
  ...over,
});

/** Pi, the one agent that ships as a Node package and nothing else. */
const managed = (over: Partial<CliRow> = {}): CliRow =>
  row({
    id: "pi",
    exe: "pi",
    source: "managed",
    requires: "npm",
    requiresUrl: "https://nodejs.org/en/download",
    installCommand: ["npm", "install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"],
    updateCommand: ["npm", "install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"],
    uninstallCommand: ["npm", "uninstall", "-g", "@earendil-works/pi-coding-agent"],
    ...over,
  });

describe("what stops a row", () => {
  it("lets a CLI Boite can fetch through", () => {
    expect(blocker(row())).toBeNull();
    expect(blocker(row({ installed: true, managed: true }))).toBeNull();
  });

  it("names the missing tool and where to get it", () => {
    // The case that started this: the package manager is not on the machine, so
    // installing is not on offer and the row says which tool is missing rather
    // than failing in a log after the click.
    const stopped = blocker(managed({ requiresPresent: false }));
    expect(stopped).toEqual({
      key: "cli.needs",
      tool: "npm",
      url: "https://nodejs.org/en/download",
    });
    expect(blocker(managed({ requiresPresent: true }))).toBeNull();
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
      managed({ requiresPresent: false }),
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
    expect(removable(managed({ installed: false, requiresPresent: true }))).toBe(false);
  });

  it("offers what Boite installed, always", () => {
    expect(removable(row({ installed: true, managed: true }))).toBe(true);
  });

  it("holds back an extension whose host tool has gone", () => {
    // Offering it would run `npm uninstall` against an npm that is not there.
    expect(removable(managed({ installed: true, requiresPresent: false }))).toBe(false);
    expect(removable(managed({ installed: true, requiresPresent: true }))).toBe(true);
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

describe("what the primary button does, and may be called", () => {
  it("offers an install for a CLI that is not there", () => {
    expect(action(row())).toBe("install");
    // Even knowing what the vendor publishes: there is nothing here to update.
    expect(action(row(), "2.1.235")).toBe("install");
  });

  it("does not call a reinstall an update", () => {
    // The bug this rule exists for: every installed row read "Update", so ten
    // CLIs that were all current offered ten updates.
    expect(action(row({ installed: true, version: "2.1.235" }), "2.1.235")).toBe("reinstall");
    expect(upToDate(row({ installed: true, version: "2.1.235" }), "2.1.235")).toBe(true);
  });

  it("offers the update when the vendor has moved on", () => {
    expect(action(row({ installed: true, version: "2.1.235" }), "2.1.240")).toBe("update");
    expect(upToDate(row({ installed: true, version: "2.1.235" }), "2.1.240")).toBe(false);
  });

  it("does not call a downgrade an update", () => {
    // Observed: claude's stable pointer says 2.1.227 while the binary on the
    // machine is 2.1.235, the two coming off different channels. Read as merely
    // "different", that offered a downgrade under the word Update.
    expect(action(row({ installed: true, version: "2.1.235" }), "2.1.227")).toBe("reinstall");
    expect(upToDate(row({ installed: true, version: "2.1.235" }), "2.1.227")).toBe(true);
  });

  it("orders versions by number rather than as text", () => {
    expect(action(row({ installed: true, version: "1.9.0" }), "1.10.0")).toBe("update");
    expect(action(row({ installed: true, version: "1.10.0" }), "1.9.0")).toBe("reinstall");
  });

  it("reads a rebuild of the same numbers as something newer", () => {
    // cursor publishes a build hash after the date, and a new hash on the same
    // day is a build the machine does not have.
    expect(
      action(row({ installed: true, version: "2026.08.11-e8db854" }), "2026.08.11-f00dcafe"),
    ).toBe("update");
    expect(
      action(row({ installed: true, version: "2026.08.11-e8db854" }), "2026.08.11-e8db854"),
    ).toBe("reinstall");
  });

  it("claims nothing about versions it cannot order", () => {
    expect(action(row({ installed: true, version: "nightly" }), "stable")).toBe("reinstall");
    expect(upToDate(row({ installed: true, version: "nightly" }), "stable")).toBe(false);
  });

  it("reads a leading v as the same version", () => {
    // The pointer says `v1.1.15` and `agy --version` says `1.1.15`, and a row
    // that read those as different offered an update to what it already had.
    expect(action(row({ installed: true, version: "1.1.15" }), "v1.1.15")).toBe("reinstall");
    expect(upToDate(row({ installed: true, version: "v1.1.15" }), "1.1.15")).toBe(true);
  });

  it("claims nothing while nobody has asked, or when asking failed", () => {
    expect(action(row({ installed: true, version: "2.1.235" }))).toBe("reinstall");
    expect(action(row({ installed: true, version: "2.1.235" }), null)).toBe("reinstall");
    // Nor when the CLI would not say what it is running.
    expect(action(row({ installed: true, version: null }), "2.1.240")).toBe("reinstall");
    expect(upToDate(row({ installed: true, version: null }), "2.1.240")).toBe(false);
  });

  it("keeps the package manager's own word for what it runs", () => {
    // `npm install -g` is the only thing Boite can do here and running it is how
    // anyone finds out whether there was anything to upgrade.
    expect(action(managed({ installed: true, requiresPresent: true }))).toBe("update");
  });

  it("names keys the dictionary actually has, since the button prints them", () => {
    for (const key of ["cli.install", "cli.update", "cli.reinstall"] as const) {
      expect(EN_MESSAGES[key]).toBeTruthy();
    }
  });
});
