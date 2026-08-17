import { describe, expect, it } from "vitest";
import { parseCombo } from "$lib/features/fastpick/combo";
import {
  joinArgv,
  resumeArgv,
  splitArgv,
  takesOpeningPrompt,
  withMcpArgs,
  withPromptArg,
} from "./resume-args";

const SESSION = "3f2a1c66-0000-4000-8000-abcdefabcdef";

/** A fastpick claude thread as the menu launches one, colour prompt included. */
const FASTPICK_CLAUDE = [
  "--harness",
  "claude-code",
  "--provider",
  "crof",
  "--model",
  "claude-opus-5",
  "--",
  "/color purple",
];

const relaunch = (cmd: string, args: string[], key: Parameters<typeof resumeArgv>[0]["key"]) =>
  resumeArgv({ cmd, args, key, sessionId: SESSION, fresh: false });

describe("splitArgv", () => {
  it("gives a direct launch one region and no separator to add back", () => {
    const argv = splitArgv("claude", ["--dangerously-skip-permissions"]);
    expect(argv).toEqual({
      own: [],
      agent: ["--dangerously-skip-permissions"],
      viaFastpick: false,
    });
    expect(joinArgv(argv)).toEqual(["--dangerously-skip-permissions"]);
  });

  // The menu writes `fastpick`, a shortcut carries what the user typed, and a
  // promotion whatever the process printed. Reading only the first as the
  // launcher left the other two with no separator, which is where codex's
  // `-c mcp_servers…` went in front of it and fastpick took it for a config
  // file path.
  it.each([
    ["fastpick.exe", "the Windows spelling of a hand-typed shortcut"],
    ["C:\\Users\\x\\.cargo\\bin\\fastpick.exe", "a full Windows path"],
    ["/home/x/.cargo/bin/fastpick", "a full POSIX path"],
    ["FastPick.EXE", "a case Windows does not distinguish"],
  ])("reads %s as the launcher it is (%s)", (cmd) => {
    const argv = splitArgv(cmd, ["--harness", "codex"]);
    expect(argv.viaFastpick).toBe(true);
    expect(argv.own).toEqual(["--harness", "codex"]);
    expect(joinArgv(withMcpArgs(argv, ["-c", 'mcp_servers.boite.command="C:\\x.exe"']))).toEqual([
      "--harness",
      "codex",
      "--",
      "-c",
      'mcp_servers.boite.command="C:\\x.exe"',
    ]);
  });

  it("does not mistake a different program for the launcher", () => {
    for (const cmd of ["myfastpick", "fastpick-shim", "notfastpick.exe", "claude"]) {
      expect(splitArgv(cmd, ["-c", "x"]).viaFastpick).toBe(false);
    }
  });

  it("splits a fastpick launch where fastpick itself stops reading", () => {
    const argv = splitArgv("fastpick", FASTPICK_CLAUDE);
    expect(argv.own).toEqual(FASTPICK_CLAUDE.slice(0, 6));
    expect(argv.agent).toEqual(["/color purple"]);
    expect(joinArgv(argv)).toEqual(FASTPICK_CLAUDE);
  });

  it("writes no separator when there is nothing to forward", () => {
    const own = ["--harness", "codex", "--provider", "acme", "--model", "m"];
    expect(joinArgv(splitArgv("fastpick", own))).toEqual(own);
  });
});

describe("resumeArgv", () => {
  it("resumes a direct claude thread on its id", () => {
    const { argv, outcome } = relaunch("claude", ["--dangerously-skip-permissions"], "claude");
    expect(outcome).toBe("resumed");
    expect(joinArgv(argv)).toEqual([
      "--dangerously-skip-permissions",
      "--resume",
      SESSION,
    ]);
  });

  it("hands a fastpick thread's resume to the agent, not to fastpick", () => {
    const { argv } = relaunch("fastpick", FASTPICK_CLAUDE, "claude");
    // The combo is untouched, so the thread comes back on the same endpoint and
    // still reads as the model it was launched on.
    expect(argv.own).toEqual(FASTPICK_CLAUDE.slice(0, 6));
    expect(parseCombo("fastpick", joinArgv(argv))?.model).toBe("claude-opus-5");
    // One separator, and the resume is behind it. The `/color purple` the row
    // still carries is gone: it is what an older Boite wrote there, and every
    // relaunch used to replay it.
    const out = joinArgv(argv);
    expect(out.filter((a) => a === "--")).toHaveLength(1);
    expect(out.slice(out.indexOf("--") + 1)).toEqual(["--resume", SESSION]);
  });

  it("drops the bar colour an older Boite wrote, wherever the row carries it", () => {
    for (const colour of ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]) {
      const args = ["--harness", "claude-code", "--provider", "c", "--model", "m", "--", `/color ${colour}`];
      const { argv } = relaunch("fastpick", args, "claude");
      expect(argv.agent).not.toContain(`/color ${colour}`);
    }
  });

  it("leaves a prompt the user typed themselves alone", () => {
    // Boite only ever wrote it on a fastpick passthrough, so a direct launch
    // keeps whatever its owner put there.
    const { argv } = relaunch("claude", ["--", "/color purple"], "claude");
    expect(argv.agent).toContain("/color purple");
    // And a sentence that merely starts the same way is not the flag.
    const typed = ["--harness", "claude-code", "--provider", "c", "--model", "m", "--", "/color purple please"];
    expect(relaunch("fastpick", typed, "claude").argv.agent).toContain("/color purple please");
  });

  it("opens the separator for a fastpick launch that had none", () => {
    // Without it, `-c mcp_servers…` below reads as fastpick's own `--config`
    // and the launch dies on a config file that does not exist.
    const own = ["--harness", "codex", "--provider", "acme", "--model", "acme-fast"];
    const { argv } = relaunch("fastpick", own, "codex");
    const out = joinArgv(argv);
    expect(out.slice(0, own.length)).toEqual(own);
    expect(out[own.length]).toBe("--");
  });

  it("keeps the MCP flags on the agent's side of the separator", () => {
    const { argv } = relaunch("fastpick", FASTPICK_CLAUDE, "claude");
    const out = joinArgv(withMcpArgs(argv, ["--mcp-config", "C:/cfg.json"]));
    expect(out.indexOf("--mcp-config")).toBeGreaterThan(out.indexOf("--"));
    expect(out.filter((a) => a === "--")).toHaveLength(1);
  });

  it("names the model again on a codex resume through fastpick", () => {
    // `codex resume` is a subcommand with a `--model` of its own, so the one
    // fastpick puts on the root never reaches the resumed session.
    const own = ["--harness", "codex", "--provider", "acme", "--model", "acme-fast"];
    const { argv } = relaunch("fastpick", own, "codex");
    expect(argv.agent).toEqual([
      "--no-alt-screen",
      "resume",
      SESSION,
      "-m",
      "acme-fast",
    ]);
  });

  it("leaves a direct codex thread's model to codex's own config", () => {
    const { argv } = relaunch("codex", [], "codex");
    expect(argv.agent).toEqual(["--no-alt-screen", "resume", SESSION]);
  });

  it("continues the latest opencode session when nothing was captured", () => {
    const own = ["--harness", "opencode", "--provider", "acme", "--model", "m"];
    const { argv, outcome } = resumeArgv({
      cmd: "fastpick",
      args: own,
      key: "opencode",
      sessionId: null,
      fresh: false,
    });
    expect(outcome).toBe("continue-latest");
    expect(joinArgv(argv)).toEqual([...own, "--", "--continue"]);
  });

  it("replays no session on a thread's first spawn", () => {
    const { argv, outcome } = resumeArgv({
      cmd: "fastpick",
      args: FASTPICK_CLAUDE,
      key: "claude",
      sessionId: SESSION,
      fresh: true,
    });
    expect(outcome).toBe("fresh");
    // The combo, and nothing behind the separator: the row's `/color purple` is
    // dropped on a first spawn too, so there is no passthrough left to open one
    // for.
    expect(joinArgv(argv)).toEqual(FASTPICK_CLAUDE.slice(0, 6));
  });

  it("resumes pi on --session and drops the picker it was launched with", () => {
    // `-r` opens pi's session picker and takes no value of its own, so leaving
    // it in place would bring the picker back up on top of the resume.
    const { argv, outcome } = relaunch("pi", ["-r", "--thinking", "high"], "pi");
    expect(outcome).toBe("resumed");
    expect(joinArgv(argv)).toEqual(["--thinking", "high", "--session", SESSION]);
  });

  it("continues the latest pi session of this folder when nothing was captured", () => {
    // `pi -c` is continueRecent(cwd), so it cannot reach another project's
    // conversation the way hermes' global `-c` can.
    const { argv, outcome } = resumeArgv({
      cmd: "pi",
      args: [],
      key: "pi",
      sessionId: null,
      fresh: false,
    });
    expect(outcome).toBe("continue-latest");
    expect(joinArgv(argv)).toEqual(["--continue"]);
  });

  it("resumes grok on --resume and drops a continue it was launched with", () => {
    const { argv, outcome } = relaunch("grok", ["-c", "--debug"], "grok");
    expect(outcome).toBe("resumed");
    expect(joinArgv(argv)).toEqual(["--debug", "--resume", SESSION]);
  });

  it("continues the latest grok session of this folder when nothing was captured", () => {
    const { argv, outcome } = resumeArgv({
      cmd: "grok",
      args: [],
      key: "grok",
      sessionId: null,
      fresh: false,
    });
    expect(outcome).toBe("continue-latest");
    expect(joinArgv(argv)).toEqual(["--continue"]);
  });

  it("resumes muse on its subcommand, replacing the one it carried", () => {
    const { argv } = relaunch("muse", ["resume", "--last"], "muse");
    expect(joinArgv(argv)).toEqual(["resume", SESSION]);
  });

  it("starts muse fresh rather than guessing at its last session", () => {
    // `muse resume --last` is not documented as scoped to a directory, and a
    // wrong-project resume is worse than a fresh conversation.
    const { argv, outcome } = resumeArgv({
      cmd: "muse",
      args: [],
      key: "muse",
      sessionId: null,
      fresh: false,
    });
    expect(outcome).toBe("no-session");
    expect(joinArgv(argv)).toEqual([]);
  });

  it("leaves an agent nothing resumes exactly as it was launched", () => {
    const { argv, outcome } = relaunch("lazygit", ["--path", "."], null);
    expect(outcome).toBe("no-builder");
    expect(joinArgv(argv)).toEqual(["--path", "."]);
  });
});

describe("the opening prompt", () => {
  it("stays a positional behind claude's separator", () => {
    const { argv } = relaunch("claude", [], "claude");
    const next = withPromptArg(argv, "claude", "read\nthe docs");
    expect(next.typed).toBe(false);
    // One line: a newline would end the prompt and type the rest as a second.
    expect(next.argv.agent).toEqual(["--resume", SESSION, "--", "read the docs"]);
  });

  it("is typed into the PTY when codex is resuming", () => {
    const { argv } = relaunch("codex", [], "codex");
    const next = withPromptArg(argv, "codex", "go");
    expect(next.typed).toBe(true);
    expect(next.argv.agent).toEqual(argv.agent);
  });

  it("is a bare positional for pi, resume included", () => {
    const { argv } = relaunch("pi", [], "pi");
    const next = withPromptArg(argv, "pi", "read the docs");
    expect(next.typed).toBe(false);
    expect(next.argv.agent).toEqual(["--session", SESSION, "read the docs"]);
  });

  it("is a bare positional for grok, resume included", () => {
    const { argv } = relaunch("grok", [], "grok");
    const next = withPromptArg(argv, "grok", "read\nthe docs");
    expect(next.typed).toBe(false);
    expect(next.argv.agent).toEqual(["--resume", SESSION, "read the docs"]);
  });

  it("says which agents can be handed one at all", () => {
    expect(takesOpeningPrompt("claude")).toBe(true);
    expect(takesOpeningPrompt("codex")).toBe(true);
    expect(takesOpeningPrompt("pi")).toBe(true);
    expect(takesOpeningPrompt("grok")).toBe(true);
    expect(takesOpeningPrompt("muse")).toBe(false);
    expect(takesOpeningPrompt("opencode")).toBe(false);
    expect(takesOpeningPrompt(null)).toBe(false);
  });
});
