import { describe, expect, it } from "vitest";
import { REDACTED, redactArgs } from "./redact";

describe("redactArgs", () => {
  it("leaves ordinary args untouched", () => {
    const { args, redacted } = redactArgs(["--resume", "--model", "opus"]);
    expect(args).toEqual(["--resume", "--model", "opus"]);
    expect(redacted).toBe(false);
  });

  it("redacts the value following a secret flag, keeping the flag", () => {
    const { args, redacted } = redactArgs(["--token", "hunter2", "--verbose"]);
    expect(args).toEqual(["--token", REDACTED, "--verbose"]);
    expect(redacted).toBe(true);
  });

  it("matches secret flags case-insensitively", () => {
    expect(redactArgs(["--API-KEY", "abc"]).args).toEqual(["--API-KEY", REDACTED]);
  });

  it("redacts --flag=value without losing the flag name", () => {
    const { args, redacted } = redactArgs(["--api-key=abcdef", "run"]);
    expect(args).toEqual([`--api-key=${REDACTED}`, "run"]);
    expect(redacted).toBe(true);
  });

  it("redacts bare tokens that look like provider keys", () => {
    // These reach the DB even when passed positionally, which is the case the
    // flag list cannot cover.
    for (const secret of [
      "sk-ant-api03-xxxxx",
      "ghp_0123456789",
      "xoxb-1-2-3",
      "AIzaSyD-ExampleKey_0123456789abcdefghij",
      "ya29.a0Example",
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      const { args, redacted } = redactArgs([secret]);
      expect(args, secret).toEqual([REDACTED]);
      expect(redacted, secret).toBe(true);
    }
  });

  it("does not redact ordinary words that merely start with a key prefix", () => {
    // Regression: bare `sk`/`pk`/`ghp` prefixes matched real arguments, and
    // since these args are replayed on respawn the thread came back with
    // `***` on its command line.
    for (const word of ["skip", "sketch", "pkg", "ghost", "xoxo", "aizawa"]) {
      const { args, redacted } = redactArgs([word]);
      expect(args, word).toEqual([word]);
      expect(redacted, word).toBe(false);
    }
  });

  it("keeps a fastpick --key id, which names a credential without carrying one", () => {
    // Regression: the id was replaced on persist, so the respawn ran
    // `fastpick --key *** …` and died on `no provider or key with id '***'`.
    const { args, redacted } = redactArgs([
      "--harness",
      "claude",
      "--provider",
      "codex-everywhere",
      "--key",
      "codex-everywhere.openai",
      "--model",
      "gpt-5.6-sol",
    ]);
    expect(args).toContain("codex-everywhere.openai");
    expect(redacted).toBe(false);
  });

  it("keeps a -p prompt, which is the agent's prompt flag and not a password", () => {
    const { args, redacted } = redactArgs(["--harness", "claude", "--", "-p", "hello"]);
    expect(args).toEqual(["--harness", "claude", "--", "-p", "hello"]);
    expect(redacted).toBe(false);
  });

  it("still redacts a real secret handed to a kept flag", () => {
    const { args, redacted } = redactArgs(["--key", "sk-ant-api03-xxxxx"]);
    expect(args).toEqual(["--key", REDACTED]);
    expect(redacted).toBe(true);
  });

  it("redacts only the value, not a following flag, when a secret ends the list", () => {
    const { args } = redactArgs(["run", "--secret"]);
    expect(args).toEqual(["run", "--secret"]);
  });

  it("handles an empty argument list", () => {
    expect(redactArgs([])).toEqual({ args: [], redacted: false });
  });

  it("treats a lone = at position 0 as a normal arg", () => {
    expect(redactArgs(["=oops"]).args).toEqual(["=oops"]);
  });
});
