import { describe, expect, it } from "vitest";
import { FASTPICK_CMD } from "./combo";
import { installCommand, uninstallCommand, updateCommand } from "./install";

describe("installCommand", () => {
  it("builds from the repository against the lockfile that shipped", () => {
    expect(installCommand()).toEqual({
      cmd: "cargo",
      args: ["install", "--git", "https://github.com/beboite/fastpick", "--locked"],
    });
  });
});

describe("updateCommand", () => {
  // The one that mattered: Update used to be Install again, so a machine with
  // fastpick already on it recompiled `main` for minutes to land on a commit
  // carrying no released version.
  it("asks fastpick for its own signed release rather than compiling one", () => {
    expect(updateCommand()).toEqual({ cmd: FASTPICK_CMD, args: ["--update"] });
  });

  it("needs no toolchain, which is the whole point of it not being cargo", () => {
    expect(updateCommand().cmd).not.toBe("cargo");
  });
});

describe("uninstallCommand", () => {
  it("removes the binary and names no config path", () => {
    const { cmd, args } = uninstallCommand();
    expect({ cmd, args }).toEqual({ cmd: "cargo", args: ["uninstall", "fastpick"] });
  });
});
