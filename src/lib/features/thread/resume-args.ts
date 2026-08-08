import type { IconKey } from "$lib/types";
import { isFastpick, parseCombo } from "$lib/features/fastpick/combo";

/**
 * What to relaunch a thread with, decided without touching a store or a clock.
 *
 * Everything here is a decision over `cmd`, `args` and a captured session id,
 * which is what makes the eight agents' resume conventions testable at all.
 * `session.ts` keeps the parts that are effects: the first-spawn latch, the
 * pending prompt, the live-session checks and the logging.
 *
 * ## A launcher is not the agent
 *
 * A fastpick thread runs `fastpick --harness … --model …`, and fastpick then
 * runs claude, codex or opencode with what came after `--`. So a thread has two
 * argument regions with two owners, and a resume flag belongs to the second one:
 *
 * - fastpick's own parser claims `-c`, `-r`, `-l`, `-n` and `-e` before anything
 *   is forwarded, and codex's MCP injection is `-c mcp_servers.…`. Appended to
 *   the bare region that read as fastpick's `--config`, and the launch died on a
 *   config file that does not exist.
 * - anything fastpick does not recognise is forwarded anyway, so the old code
 *   worked by accident for every flag whose name it happened not to share.
 *
 * Splitting on `--` makes that structural rather than lucky: fastpick reads the
 * first region, the agent gets the second, and one `--` separates them however
 * many flags either side grows.
 */

/** A thread's command line, split by who reads which half. */
export interface AgentArgv {
  /** What fastpick reads. Empty when the thread launches its agent directly. */
  own: string[];
  /** What the agent gets. Everything, for a direct launch. */
  agent: string[];
  /** Whether `own` has a reader at all. */
  viaFastpick: boolean;
}

const CODEX_NO_ALT_SCREEN = "--no-alt-screen";

export function splitArgv(cmd: string, args: readonly string[]): AgentArgv {
  // By binary name, never by the whole string: a thread launched as
  // `fastpick.exe` or by full path is the same launcher with the same two
  // regions, and calling it a direct launch is what drops the separator that
  // keeps `-c mcp_servers…` out of fastpick's own hands. See `isFastpick`.
  if (!isFastpick(cmd)) {
    return { own: [], agent: [...args], viaFastpick: false };
  }
  const at = args.indexOf("--");
  if (at < 0) return { own: [...args], agent: [], viaFastpick: true };
  return {
    own: args.slice(0, at),
    agent: args.slice(at + 1),
    viaFastpick: true,
  };
}

/**
 * The two regions back into one command line.
 *
 * The separator is written only when there is something to forward: a bare
 * trailing `--` is noise, and it would make `parseCombo` read a thread as
 * carrying an empty passthrough it never had.
 */
export function joinArgv(argv: AgentArgv): string[] {
  if (!argv.viaFastpick) return [...argv.agent];
  if (argv.agent.length === 0) return [...argv.own];
  return [...argv.own, "--", ...argv.agent];
}

/** The same argv with the agent's half replaced. */
function withAgent(argv: AgentArgv, agent: string[]): AgentArgv {
  return { ...argv, agent };
}

/** The eight names Claude Code's `/color` took, and nothing else. */
const BAR_COLOR_PROMPT = /^\/color (?:red|blue|green|yellow|purple|orange|pink|cyan)$/;

/**
 * Drops the `/color <name>` an older Boite put in front of the agent.
 *
 * It painted Claude Code's prompt bar to match the icon, and it cost a slash
 * command running and an answer printed at the top of every launch, for a strip
 * of colour the sidebar was already showing. Threads created back then still
 * carry it in their stored args, and a relaunch replays what is stored.
 *
 * Dropped on the way through rather than migrated out of the rows: a thread's
 * command line is what the user sees and can edit, and rewriting it underneath
 * them to remove an argument Boite put there itself is the more surprising of
 * the two. Only on the passthrough of a fastpick launch, which is the only
 * place Boite ever wrote it, so a `/color` somebody typed themselves stays.
 */
function withoutBarColor(argv: AgentArgv): AgentArgv {
  if (!argv.viaFastpick) return argv;
  const agent = argv.agent.filter((a) => !BAR_COLOR_PROMPT.test(a));
  return agent.length === argv.agent.length ? argv : { ...argv, agent };
}

function stripFlag(args: string[], flags: string[], takesValue: boolean): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (flags.includes(a)) {
      if (takesValue) skipNext = true;
      continue;
    }
    if (flags.some((f) => a.startsWith(`${f}=`))) continue;
    out.push(a);
  }
  return out;
}

function withCodexNoAltScreen(args: string[]): string[] {
  if (args.includes(CODEX_NO_ALT_SCREEN)) return args;
  return [CODEX_NO_ALT_SCREEN, ...args];
}

function withGrokContinue(args: string[]): string[] {
  if (
    args.includes("--continue") ||
    args.includes("-c") ||
    args.includes("--resume") ||
    args.includes("-r")
  ) {
    return args;
  }
  return [...args, "--continue"];
}

function withOpencodeContinue(args: string[]): string[] {
  if (
    args.includes("--continue") ||
    args.includes("-c") ||
    args.includes("--session") ||
    args.includes("-s")
  ) {
    return args;
  }
  return [...args, "--continue"];
}

function withAntigravityContinue(args: string[]): string[] {
  if (
    args.includes("--continue") ||
    args.includes("-c") ||
    args.includes("--conversation")
  ) {
    return args;
  }
  return [...args, "--continue"];
}

export type ResumeBuilder = (args: string[], sessionId: string) => string[];

const builders: Partial<Record<NonNullable<IconKey>, ResumeBuilder>> = {
  // claude --resume <id> picks a specific session.
  claude: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "-r"], true);
    return [...filtered, "--resume", sessionId];
  },
  // codex resume <id> subcommand-form.
  codex: (args, sessionId) => {
    const stripped = args.filter(
      (a) => a !== "resume" && a !== sessionId && a !== CODEX_NO_ALT_SCREEN,
    );
    return [CODEX_NO_ALT_SCREEN, ...stripped, "resume", sessionId];
  },
  // Current opencode uses --session <id>; strip legacy resume args too.
  opencode: (args, sessionId) => {
    const withoutContinue = stripFlag(args, ["--continue", "-c"], false);
    const filtered = stripFlag(
      withoutContinue,
      ["--session", "-s", "--resume", "-r"],
      true,
    );
    return [...filtered, "--session", sessionId];
  },
  // cursor-agent --resume <chat-id> picks a specific session.
  cursor: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "--continue"], true);
    return [...filtered, "--resume", sessionId];
  },
  // agy --conversation <UUID> picks a specific conversation.
  antigravity: (args, sessionId) => {
    const withoutContinue = stripFlag(args, ["--continue", "-c"], false);
    const filtered = stripFlag(withoutContinue, ["--conversation"], true);
    return [...filtered, "--conversation", sessionId];
  },
  // `-r, --resume[=value]`: the value is optional, so it only attaches with an
  // `=`. Space-separated, the flag opens the picker and the id falls through as
  // a positional — which copilot then looks up as a session *name* and rejects:
  // "No session, task, or name matched '<uuid>'". The id was never the problem.
  copilot: (args, sessionId) => {
    const filtered = stripFlag(args, ["--resume", "-r"], true);
    return [...filtered, `--resume=${sessionId}`];
  },
  // grok --resume <id> picks a specific session; -c continues the latest
  // session of the current directory.
  grok: (args, sessionId) => {
    const withoutContinue = stripFlag(args, ["--continue", "-c"], false);
    const filtered = stripFlag(withoutContinue, ["--resume", "-r"], true);
    return [...filtered, "--resume", sessionId];
  },
  // hermes --resume <id|title> picks a specific session.
  hermes: (args, sessionId) => {
    const withoutContinue = stripFlag(args, ["--continue", "-c"], false);
    const filtered = stripFlag(withoutContinue, ["--resume", "-r"], true);
    return [...filtered, "--resume", sessionId];
  },
};

/**
 * Codex reads `--model` on its root only. `codex resume <id>` is a subcommand
 * with a model option of its own, so the one fastpick passes never reaches the
 * resumed session and it comes back on whatever `~/.codex/config.toml` names —
 * a different model on the same endpoint, silently. The combo already says
 * which model this thread is, so the resume says it too.
 *
 * Only for a thread that goes through fastpick: a direct `codex` thread never
 * had a model named at launch, and inventing one here would override the user's
 * own config.
 */
function withCodexResumeModel(argv: AgentArgv, cmd: string, agent: string[]): string[] {
  if (!argv.viaFastpick) return agent;
  if (agent.includes("-m") || agent.includes("--model")) return agent;
  const combo = parseCombo(cmd, argv.own);
  if (!combo) return agent;
  return [...agent, "-m", combo.model];
}

/** Why the relaunch looks the way it does, for the caller's log line. */
export type ResumeOutcome =
  | "fresh"
  | "no-builder"
  | "no-session"
  | "continue-latest"
  | "resumed";

export interface ResumeInput {
  cmd: string;
  args: readonly string[];
  key: IconKey;
  sessionId: string | null;
  /** First spawn of a thread the user just created: never a resume. */
  fresh: boolean;
}

/**
 * The argv this thread comes back on.
 *
 * Held as two regions rather than one list, because the callers that come after
 * (MCP flags, an opening prompt, claude's live-session check) all have to land
 * on the agent's side of the separator too.
 */
export function resumeArgv(input: ResumeInput): {
  argv: AgentArgv;
  outcome: ResumeOutcome;
} {
  const argv = withoutBarColor(splitArgv(input.cmd, input.args));
  const { key, sessionId } = input;
  if (!key) return { argv, outcome: "no-builder" };
  const builder = builders[key];
  if (!builder) return { argv, outcome: "no-builder" };

  const agent = key === "codex" ? withCodexNoAltScreen(argv.agent) : argv.agent;
  if (input.fresh) return { argv: withAgent(argv, agent), outcome: "fresh" };

  if (!sessionId) {
    // grok -c is scoped to the current directory, so continuing the latest
    // session is safe even without a captured id. hermes -c is global (last
    // session of any project), so it gets no fallback: wrong-project resumes
    // are worse than a fresh session.
    const continued =
      key === "opencode"
        ? withOpencodeContinue(agent)
        : key === "grok"
          ? withGrokContinue(agent)
          : key === "antigravity"
            ? withAntigravityContinue(agent)
            : null;
    return continued
      ? { argv: withAgent(argv, continued), outcome: "continue-latest" }
      : { argv: withAgent(argv, agent), outcome: "no-session" };
  }

  let out = builder(agent, sessionId);
  if (key === "codex") out = withCodexResumeModel(argv, input.cmd, out);
  return { argv: withAgent(argv, out), outcome: "resumed" };
}

/**
 * How this CLI takes an opening prompt, or null when it takes none.
 *
 * `claude [options] [prompt]` always does, resume included — but only behind a
 * `--`. Its `--mcp-config <configs...>` is variadic, so a bare positional after
 * it is read as a second config file and the launch dies on
 * "MCP config file not found: <the first word of the sentence>".
 *
 * `codex [options] [prompt]` takes one plainly (nothing in its argument list is
 * variadic), but only for a fresh session: its resume is the subcommand `codex
 * resume <id>`, which occupies the same position.
 *
 * Nothing else is listed. A guess here does not misfire quietly — it costs the
 * thread its whole launch — and the cost of being wrong the other way is one
 * agent that comes back up without being told why its folder changed.
 */
function promptSeparator(key: IconKey, agent: string[]): string[] | null {
  if (key === "claude") return ["--"];
  if (key === "codex") return agent.includes("resume") ? null : [];
  return null;
}

/**
 * Whether a thread started on this CLI would be handed an opening instruction.
 *
 * Asked before the launch, by `thread_spawn`: a new terminal that silently
 * drops the prompt it was opened for is a half-success dressed as a success —
 * the calling agent is told the work was handed off, and the thread it opened
 * sits at a bare prompt knowing nothing.
 */
export function takesOpeningPrompt(key: IconKey): boolean {
  // A fresh thread never carries a resume, which is the only thing that makes
  // the positional ambiguous.
  return promptSeparator(key, []) !== null;
}

/**
 * The MCP flags, on the agent's side of the separator.
 *
 * Last of the flags and before any prompt: an MCP flag appended after a
 * positional would be read as part of the sentence.
 */
export function withMcpArgs(argv: AgentArgv, mcp: readonly string[]): AgentArgv {
  if (mcp.length === 0) return argv;
  return withAgent(argv, [...argv.agent, ...mcp]);
}

/**
 * The opening prompt as a positional, or nothing when this CLI cannot take one
 * on this launch. `typed` says the caller has to type it into the PTY instead.
 */
export function withPromptArg(
  argv: AgentArgv,
  key: IconKey,
  prompt: string,
): { argv: AgentArgv; typed: boolean } {
  const separator = promptSeparator(key, argv.agent);
  if (separator === null) return { argv, typed: true };
  // Any newline would end the prompt and start typing the rest as a second
  // one, so the whole briefing arrives as a single line.
  const line = prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return {
    argv: withAgent(argv, [...argv.agent, ...separator, line]),
    typed: false,
  };
}

/** The claude agent view, scoped to one project, in place of a resume. */
export function agentsViewArgv(argv: AgentArgv, cwd: string): AgentArgv {
  return withAgent(argv, ["agents", "--cwd", cwd]);
}

/** Drops one flag from the agent's half, for a resume that turned out dead. */
export function withoutAgentFlag(argv: AgentArgv, flag: string): AgentArgv {
  return withAgent(
    argv,
    argv.agent.filter((a) => a !== flag),
  );
}
