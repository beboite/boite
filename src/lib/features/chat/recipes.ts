import type { IconKey } from "$lib/types";

/**
 * How one agent answers a single message, when it can be asked for one.
 *
 * Every agent Boite knows runs the same way — one PTY per turn, spawned and
 * reaped — and this table decides only how its output is read back:
 *
 *  - `json`: the CLI streams events and the shape is known, because it was run
 *    and read rather than looked up. Real chat bubbles.
 *  - `text`: the CLI has a documented print mode but no event stream. Its
 *    stdout, stripped of escapes, is the answer. Nothing is parsed, so nothing
 *    can be parsed wrong; a flag that turns out not to exist shows up as the
 *    process's own error in the bubble.
 *  - absent from this table: no print mode Boite can vouch for. Those agents
 *    run their normal interactive selves and the bubble holds a terminal. Less
 *    pretty, always correct, and the reason no agent is ever greyed out.
 *
 * Promoting an agent is one entry. It costs nothing to leave one out, and a
 * guessed event schema would cost the user a turn that silently reads as empty.
 */
export type ChatMode = "json" | "text" | "pty";

/** What a parsed line of a `json` agent's output turned out to be. */
export type ChatEvent =
  | { kind: "text"; text: string }
  /** The agent named its own session; keep it so the next turn continues it. */
  | { kind: "session"; id: string }
  | { kind: "done"; text?: string }
  /**
   * The turn ended badly. `message` names the failure; `text` is whatever the
   * agent had already said, which is kept because an answer that arrived and
   * then hit a limit is still an answer — replacing it with the reason loses
   * the only part the user wanted.
   */
  | { kind: "error"; message: string; text?: string };

export interface TurnSpec {
  prompt: string;
  /**
   * A session the agent has already written to, and can be asked to continue.
   * Null until one exists — which is not the same as `newSessionId` being set,
   * and keeping them apart is the whole reason there are two fields: asking a
   * CLI to resume an id it has never seen fails the turn outright.
   */
  sessionId: string | null;
  /**
   * An id chosen for a session that does not exist yet, for the CLIs that let
   * the caller name one. Set on the first turn only, and only for those.
   */
  newSessionId: string | null;
}

export interface ChatRecipe {
  mode: Exclude<ChatMode, "pty">;
  /**
   * A session id chosen before the first turn, for the CLIs that accept one.
   * Without it a chat has no continuity until the agent has answered once, and
   * a turn that fails leaves the conversation with no thread to pick back up.
   */
  mintsSession: boolean;
  args(turn: TurnSpec): string[];
  /** Only for `json` recipes. One parsed line in, at most one event out. */
  read?(line: unknown): ChatEvent | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

const RECIPES: Partial<Record<NonNullable<IconKey>, ChatRecipe>> = {
  // Verified against claude 2.1.220. `--verbose` is not optional: without it
  // `--output-format stream-json` is refused outright. The session id is ours
  // to choose on the first turn and ours to replay after, which is what makes
  // the handover able to hand a real conversation to a terminal.
  claude: {
    mode: "json",
    mintsSession: true,
    args: ({ prompt, sessionId, newSessionId }) => [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      // `--session-id` names a session about to exist; `--resume` continues one
      // that does. Sending the second on the first turn is refused outright —
      // there is nothing under that id yet.
      ...(newSessionId
        ? ["--session-id", newSessionId]
        : sessionId
          ? ["--resume", sessionId]
          : []),
      prompt,
    ],
    read(line) {
      const type = str(field(line, "type"));
      if (type === "assistant") {
        const content = field(field(line, "message"), "content");
        if (!Array.isArray(content)) return null;
        const text = content
          .filter((part) => str(field(part, "type")) === "text")
          .map((part) => str(field(part, "text")) ?? "")
          .join("");
        return text ? { kind: "text", text } : null;
      }
      if (type === "result") {
        if (field(line, "is_error") === true) {
          // The subtype is the only thing that names the failure — a hook that
          // refused, a turn limit, an API error — and `result` at that point is
          // usually the assistant's last words rather than a diagnosis. Both
          // are carried: one is what the user reads, the other is what makes
          // the log worth having.
          return {
            kind: "error",
            message: str(field(line, "subtype")) ?? "error",
            text: str(field(line, "result")) ?? undefined,
          };
        }
        // The streamed pieces are the same text, so this is a floor rather
        // than an addition: it is what fills the bubble when a turn produced
        // a result and no assistant message, which is what a refusal looks
        // like.
        return { kind: "done", text: str(field(line, "result")) ?? undefined };
      }
      return null;
    },
  },

  // Verified against the codex CLI shipped alongside. It names its own thread
  // and hands it back on the first line, so there is nothing to mint; the id
  // comes back as a `resume` subcommand rather than a flag.
  //
  // `--skip-git-repo-check` because a chat's scratch directory is deliberately
  // not a repository — refusing to run outside one is a sensible default for a
  // coding session and the wrong one for a conversation about what to build.
  codex: {
    mode: "json",
    mintsSession: false,
    args: ({ prompt, sessionId }) => [
      "exec",
      ...(sessionId ? ["resume", sessionId] : []),
      "--json",
      "--skip-git-repo-check",
      prompt,
    ],
    read(line) {
      const type = str(field(line, "type"));
      if (type === "thread.started") {
        const id = str(field(line, "thread_id"));
        return id ? { kind: "session", id } : null;
      }
      if (type === "item.completed") {
        const item = field(line, "item");
        if (str(field(item, "type")) !== "agent_message") return null;
        const text = str(field(item, "text"));
        return text ? { kind: "text", text } : null;
      }
      if (type === "turn.completed") return { kind: "done" };
      if (type === "turn.failed" || type === "error") {
        return { kind: "error", message: str(field(line, "message")) ?? "the turn failed" };
      }
      return null;
    },
  },

  // Print modes that are documented but whose event streams Boite has not run
  // and read. Their stdout is taken as the answer, which is a claim about the
  // flag and not about any schema — the honest limit of what can be promised
  // without the binary in hand.
  //
  // copilot is deliberately absent. Its print mode belongs to the standalone
  // `copilot` binary, and the preset here launches `gh copilot`, whose
  // subcommands are `explain` and `suggest` — `gh copilot -p` is an error, so
  // the entry would have turned every turn into one. It falls back to a
  // terminal until the preset says which of the two CLIs it means.
  opencode: {
    mode: "text",
    mintsSession: false,
    args: ({ prompt, sessionId }) => [
      "run",
      ...(sessionId ? ["--session", sessionId] : []),
      prompt,
    ],
  },
  cursor: {
    mode: "text",
    mintsSession: false,
    args: ({ prompt, sessionId }) => [
      "-p",
      ...(sessionId ? ["--resume", sessionId] : []),
      prompt,
    ],
  },
  grok: {
    mode: "text",
    mintsSession: false,
    args: ({ prompt }) => ["-p", prompt],
  },
  // Verified by running agy 1.1.7: `--print` answers one prompt on stdout and
  // exits, and the answer arrives as prose with no escape sequences in it.
  // Stateless on purpose — it resumes with `--conversation <id>` and prints no
  // id to pass back, and `--continue` picks the most recent conversation on
  // the machine, which two chats would take turns stealing from each other.
  antigravity: {
    mode: "text",
    mintsSession: false,
    args: ({ prompt }) => ["--print", prompt],
  },
};

export function recipeFor(key: IconKey): ChatRecipe | null {
  return (key && RECIPES[key]) || null;
}

/**
 * Colour, cursor moves and OSC titles a print-mode CLI still emits.
 *
 * Only ever applied to a `text` recipe, where the whole answer is the process's
 * stdout: without it the bubble opens with `[0m`. A `json` recipe needs
 * none of it, and the fallback keeps every byte because a terminal is what
 * draws it.
 */
const ANSI = new RegExp(
  [
    "\\u001b\\[[0-?]*[ -/]*[@-~]", // CSI: colour, cursor, erase
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", // OSC: window titles
    "\\u001b[@-Z\\\\-_]", // the short two-byte escapes
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]", // stray control bytes
  ].join("|"),
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export function chatModeFor(key: IconKey): ChatMode {
  return recipeFor(key)?.mode ?? "pty";
}
