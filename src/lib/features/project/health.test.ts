import { describe, expect, it } from "vitest";
import {
  gitFailure,
  gitFailureKey,
  projectHealth,
  refreshLogLevel,
  repoCardsVisible,
  type HealthProbe,
} from "./health";

const probe = (over: Partial<HealthProbe> = {}): HealthProbe => ({
  folder: "occupied",
  gitLoaded: true,
  gitIsRepo: true,
  gitError: null,
  ...over,
});

describe("gitFailure", () => {
  it("reads a Windows canonicalize failure through its os error tail", () => {
    expect(
      gitFailure(
        "invalid path: Le chemin d'accès spécifié est introuvable. (os error 3)",
      ),
    ).toBe("pathMissing");
  });

  it("reads the unix spelling too", () => {
    expect(gitFailure("No such file or directory (os error 2)")).toBe("pathMissing");
  });

  it("recognises git's own fatal", () => {
    expect(
      gitFailure("fatal: not a git repository (or any of the parent directories): .git"),
    ).toBe("notARepo");
  });

  it("recognises a detached head", () => {
    expect(gitFailure("HEAD detached at 5451a15")).toBe("detached");
  });

  it("says nothing about anything else", () => {
    expect(gitFailure("git: command not found")).toBe("unknown");
  });
});

describe("gitFailureKey", () => {
  it("sends the unmapped case to the generic line", () => {
    expect(gitFailureKey("unknown")).toBe("git.readFolderFailed");
  });

  it("gives each mapped case its own", () => {
    expect(gitFailureKey("pathMissing")).toBe("project.folderGone");
    expect(gitFailureKey("notARepo")).toBe("project.notARepo");
    expect(gitFailureKey("detached")).toBe("git.detachedHead");
  });
});

describe("refreshLogLevel", () => {
  it("keeps a folder that is not a repository out of the error log", () => {
    // A fresh install's Scratch project sits on the home directory and is
    // refreshed every ten seconds. At `error` that is six lines a minute about
    // a folder nobody ever said was a repository.
    expect(refreshLogLevel("notARepo")).toBe("debug");
    expect(refreshLogLevel("pathMissing")).toBe("debug");
  });

  it("still reports a failure nothing on the page explains", () => {
    expect(refreshLogLevel("unknown")).toBe("error");
    expect(refreshLogLevel("detached")).toBe("error");
  });
});

describe("projectHealth", () => {
  it("waits rather than accusing while the probe is out", () => {
    expect(projectHealth(probe({ folder: null, gitLoaded: false }))).toBe("checking");
  });

  it("draws the cards while it waits", () => {
    expect(repoCardsVisible("checking")).toBe(true);
    expect(repoCardsVisible("ok")).toBe(true);
    expect(repoCardsVisible("missing")).toBe(false);
    expect(repoCardsVisible("notRepo")).toBe(false);
  });

  it("calls a missing folder missing", () => {
    expect(projectHealth(probe({ folder: "missing" }))).toBe("missing");
  });

  it("believes a git error about a path that is gone, probe or no probe", () => {
    expect(
      projectHealth(
        probe({ folder: null, gitError: "invalid path: ... (os error 3)" }),
      ),
    ).toBe("missing");
  });

  it("calls a folder that is there but has no repository notRepo", () => {
    expect(projectHealth(probe({ gitIsRepo: false }))).toBe("notRepo");
  });

  it("leaves a healthy repository alone", () => {
    expect(projectHealth(probe())).toBe("ok");
  });

  it("does not call a repository broken because one refresh failed", () => {
    expect(projectHealth(probe({ gitError: "git: command not found" }))).toBe("ok");
  });
});
