//! What the agent is told it can do.
//!
//! Paid for in every session that connects and again in the context window that
//! reads it, so every line here is written to be short. The split between
//! `common_tools` and `thread_tools` is not cosmetic: an agent wired from a
//! credentials file has no terminal, so the tools that act on one would answer
//! it a refusal every time, and a tool that always refuses is worse than a tool
//! that is not there.

use serde_json::{json, Value};

/// The tool list, and the one place this shim spends tokens unconditionally:
/// every session that connects reads all of it before doing anything. Each
/// description says what the tool does and, where two tools are confusable,
/// which one the other case belongs to. Everything a failed call would explain
/// on its own is left to the failure.
///
/// Read once, at connection, before any tool is called. The list does not
/// depend on the caller: a shim with no credential was launched from a config
/// file, and a config file is only ever written for a project, so the answer
/// is the same set either way.
///
/// It used to describe the answer format and nothing else, which told an agent
/// how to read a reply it had no reason to ask for. A tool nobody knows to
/// reach for does not exist, and none of these have an equivalent anywhere
/// else: the todo list is shared with the user and with the other terminals,
/// the worktree is why the work is not visible in their checkout, and the pane
/// is the only way to show them something.
///
/// Written as moments rather than as a catalogue. The tool list already says
/// what each one does; what is missing without this is when any of it applies.
pub const INSTRUCTIONS: &str = "\
You are running inside a Boite terminal. Boite is the user's workspace: several \
agent terminals side by side, one shared todo list per project, and a git \
worktree per terminal. The tools below reach that workspace, and nothing else \
you have reaches it.

Where you are. Call whereami first: this thread, this project, this worktree, \
this branch. A detached worktree is discarded when the thread closes. \
worktree_status adds the branch list when you need to pick a name.

When to reach for these:

- Starting on something the user asked for: todo_list first. The card usually \
carries context this conversation does not, and another terminal may already be \
on it.
- Finishing a task that was on the list: todo_claim. It does not tick the card \
off, it moves it to awaiting the user's confirmation.
- Work worth keeping: worktree_branch for a new branch, worktree_reserve to \
continue one that exists. Until you call one of them the work is on a detached \
head and closing the thread throws it away. Do this before you finish, not after.
- Work that surfaced along the way and does not belong in this turn: todo_add \
rather than a note in your answer, which nobody reads again.
- Something the user should look at, a diff, a dev server, a file: pane_open puts \
it beside this terminal. Pass path for editor. Printing a path only \
works if they are reading this one.
- A page you opened: browser action=status|snapshot|click|type|press|scroll|\
navigate|reload|wait_for|close|screenshot. Desktop window only for read/drive; \
a pane drawn by a browser or a phone cannot be reached into.
- A page you are done with: browser action=close, before you answer. A frame \
left standing takes half the user's terminal for nothing. Leave it open only \
when the page itself is what you are showing them; the window closes the ones \
you forget, but only once they are off the screen and only after a wait.
- The pane is theirs, not yours: it carries a mark saying you are driving it and \
a button that takes it back, and after they press it your calls at that pane are \
refused. That is the user deciding, not a fault to work around.
- Independent work that should run at the same time: thread_spawn. It answers \
with the new thread id; terminal_transcript and thread_wait take that id.
- A worker you have finished reading: thread_close, with the id the spawn gave \
you. You opened it, so you put it away, and a worker left behind sits in the \
user's sidebar until they sweep it by hand. Claim its branch first if it wrote \
anything: the close takes its detached worktree with it.

Answers are TOON: `key: value` for a single record, and `name(N):` followed by a \
header row then one row per item for a list.";

/// Who a global orchestrator is. One paragraph, swapped for the scoped one
/// when the row carries a project: everything after it is the same craft.
const ORCHESTRATOR_GLOBAL: &str = "\
You are this workspace's orchestrator: the one thread the user talks to. \
Everything else here is a worker, and you see them from the outside.";

/// What an orchestrator session reads after its opening paragraph.
///
/// Written as moments, short, because it is paid on every connection. The
/// autonomy level rides in `BOITE_AUTONOMY`; enforcement is Boite's, this text
/// only tells the agent not to look for a detour.
pub const ORCHESTRATOR_INSTRUCTIONS: &str = "\
You do not do the work. A request that needs edits, a build or a review gets \
a terminal of its own via thread_spawn, with a prompt written for someone who \
was not in this conversation.

A worker that needs one more line at its prompt gets thread_dispatch. The \
line is typed by the device, only at the worker's prompt, visibly marked as \
yours; the pulse tells you whether it was delivered, dropped or refused. A \
finished worker you are done with gets thread_dismiss.

You wait by sleeping in workspace_pulse. Never a loop, never a timer. If \
nothing happened, nothing happened. The pulse already carries each terminal's \
phase; read a transcript only when the pulse is not enough — a transcript \
costs a hundred pulses.

If a worker is waiting on the user, tell the user instead of answering in \
their place. A permission request belongs to the user, never to you.

Answer with exactly one say of urgency answer per turn. Before anything you \
expect to be long, send a say of urgency ack: thirty seconds of silence reads \
as a failure on a phone. Put in aloud one or two sentences written to be \
heard, not read. Speak the user's language.

Your autonomy level is in BOITE_AUTONOMY. As observer you watch and answer \
and open nothing. Asked for something your level forbids, say so and offer to \
raise it. When Boite refuses you, report the refusal as it was said.";

pub fn tools() -> Value {
    let mut list = common_tools();
    if let (Some(all), Value::Array(tail)) = (list.as_array_mut(), thread_tools()) {
        all.extend(tail);
    }
    list
}

/// The list a given role reads. Only `orchestrator` adds anything: a worker
/// handed the pulse would be a worker taught to idle in a long-poll.
pub fn tools_for_role(role: Option<&str>) -> Value {
    let mut list = tools();
    if role == Some("orchestrator") {
        if let (Some(all), Value::Array(tail)) = (list.as_array_mut(), orchestrator_tools()) {
            all.extend(tail);
        }
    }
    list
}

/// The instructions a given role reads, same selection as [`tools_for_role`].
///
/// The scope names the project a scoped orchestrator answers for, so its
/// opening paragraph says whose it is and what stays with the workspace one.
/// A scope without the role means nothing: workers carry no instructions of
/// their own whatever their row says about projects.
pub fn instructions_for_role(role: Option<&str>, scope: Option<&str>) -> String {
    match role {
        Some("orchestrator") => {
            let opening = match scope {
                Some(project) => format!(
                    "You are project {project}'s orchestrator: the one thread the user talks \
                     to about this project. Every worker you see lives here. Anything beyond \
                     it, another project or the workspace as a whole, belongs to the user or \
                     to the workspace orchestrator: do not reach for it, say whose it is."
                ),
                None => ORCHESTRATOR_GLOBAL.to_string(),
            };
            format!("{INSTRUCTIONS}\n\n{opening}\n\n{ORCHESTRATOR_INSTRUCTIONS}")
        }
        _ => INSTRUCTIONS.to_string(),
    }
}

/// Orchestrator only, selected on the role Boite stamped into the row and the
/// environment. The endpoint re-checks the row on every call, so a process
/// that exports `BOITE_ROLE` by hand reads a longer menu of refusals.
fn orchestrator_tools() -> Value {
    json!([
        {
            "name": "workspace_pulse",
            "description": "Wait here. Answers what changed since your cursor — worker phases, \
                            user messages — or nothing when the wait ran out, which is an answer \
                            too. This is how you wait: never call anything in a loop. Pass the \
                            seq you were last given.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sinceSeq": { "type": "number", "description": "Your cursor: the seq of the last answer. 0 the first time." },
                    "timeoutMs": { "type": "number", "description": "How long to wait when nothing changed. Default 30000, max 120000; 0 answers now." },
                    "project": { "type": "string", "description": "One project id. Omit for the whole workspace." }
                },
                "additionalProperties": false
            },
            "annotations": { "title": "Pulse", "readOnlyHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "say",
            "description": "Your reply to the user. text goes into the chat; aloud is the one-or-two \
                            sentence version to be read out loud. A turn ends with exactly one say \
                            of urgency answer; a say of urgency ack in the middle of a turn says \
                            you are working.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "The reply, one short paragraph." },
                    "aloud": { "type": "string", "description": "One or two sentences written to be heard. Omit to stay silent." },
                    "urgency": { "type": "string", "enum": ["ack", "answer", "alert"], "description": "answer ends the turn; ack says you are on it; alert interrupts." }
                },
                "required": ["text"],
                "additionalProperties": false
            },
            "annotations": { "title": "Say", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "thread_dispatch",
            "description": "Queue one line for a worker terminal's prompt. It is typed by the \
                            device that owns that terminal, only when the worker is at its \
                            prompt, with a visible mark saying it came from you — never during \
                            a permission dialog, never into a muted thread, never into another \
                            orchestrator. You learn the outcome on the pulse as \
                            dispatch.settled: delivered, dropped or refused with the reason.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "threadId": { "type": "string", "description": "The target worker's thread id." },
                    "text": { "type": "string", "description": "The line to type, written for someone who was not in this conversation." },
                    "mode": { "type": "string", "enum": ["queue", "now"], "description": "queue waits for the prompt; now lands only if the worker is at it right now." }
                },
                "required": ["threadId", "text"],
                "additionalProperties": false
            },
            "annotations": { "title": "Dispatch", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "thread_dismiss",
            "description": "Put a finished worker away. Refused while the worker is running or \
                            waiting on the user — the same rule as the user's own settle. The \
                            terminal is not killed; it leaves the active list.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "threadId": { "type": "string", "description": "The worker's thread id." }
                },
                "required": ["threadId"],
                "additionalProperties": false
            },
            "annotations": { "title": "Dismiss", "destructiveHint": false, "openWorldHint": false }
        }
    ])
}

fn common_tools() -> Value {
    json!([
        {
            "name": "todo_list",
            "description": "List this project's todos: short id, state, title, description.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Todos", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "todo_add",
            "description": "Add one card to this project's list: a one-line title, and a \
                            description for whatever does not fit in it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "The task in one short line, around 60 characters. This is \
                                        all the list shows; a longer one is cut off there. Write \
                                        the outcome, not the reasoning."
                    },
                    "description": {
                        "type": "string",
                        "description": "Everything that does not belong in the title: context, the \
                                        files involved, constraints, how to tell it is done. As \
                                        long as it needs to be, and left out entirely when the \
                                        title already says it all."
                    }
                },
                "required": ["title"],
                "additionalProperties": false
            },
            "annotations": { "title": "Add todo", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "todo_claim",
            "description": "Report a todo as done. Does NOT tick it off: it moves to awaiting the \
                            user's confirmation, which only they can give.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Id from todo_list or from the task prompt; the short form works." },
                    "note": { "type": "string", "description": "One line on what changed." },
                    "commit": {
                        "type": "string",
                        "description": "Sha the work landed in, if it was committed. Resolved against \
                                        the repository, so one that does not exist reads as unknown — \
                                        omit rather than guess."
                    }
                },
                "required": ["id"],
                "additionalProperties": false
            },
            "annotations": { "title": "Claim todo", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "whereami",
            "description": "This terminal, this project, this worktree, this branch. Cheaper than \
                            workspace_snapshot; call it first. worktree_status adds the branch list.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Where", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "worktree_status",
            "description": "Where this terminal works: its own detached worktree of the project, \
                            isolated from the user's checkout and from other terminals, sharing one \
                            history. Reports path, repo, branch if one was taken, uncommitted \
                            changes, what the remote has of the branch, and the existing branches.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Worktree", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "workspace_snapshot",
            "description": "Everything Boite knows about itself right now, in one answer: every \
                            project and whether its folder is still there, every thread with what \
                            its row claims, the terminals this workspace actually has a live \
                            process for, and what is on the window. Read it before asking a human \
                            what they see, and read `screen` before asking what it looks like: it \
                            carries every pane with its kind, its title and its measured size, \
                            which pane has focus, and what is covering the layout. A pane listed \
                            with a size of zero is open and not visible, and nothing else reports \
                            that. `screen.at` is a heartbeat, so one far behind `takenAtMs` means \
                            the window stopped answering, which is itself the answer. The two \
                            thread lists are the other half: a thread whose status says running \
                            and whose id is not in livePtys is a dead terminal, and that \
                            comparison is not visible from anywhere else. Carries no secret, so \
                            it can be pasted into an issue.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Snapshot", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "workspace_timeline",
            "description": "What happened in this workspace, newest first: what agents did and were                             refused, what moved on the todo list, and when each terminal was                             opened, all on one clock. Read it when something changed and you do                             not know what else changed with it. workspace_search finds where                             something is; this shows what it happened next to.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "One project. Omit for the whole workspace." },
                    "limit": { "type": "number", "description": "How many moments. Default 40, max 200." }
                }
            },
            "annotations": { "title": "Timeline", "readOnlyHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "logs",
            "description": "What this boite logged, across its desktop window, its server, this \
                            MCP shim and the webview, on one clock. Read it when something \
                            failed and the terminal does not say why: a command the bus refused, \
                            a child that exited, a request that never came back. `tail` is the \
                            last few hundred records this host still has in memory and is \
                            instant; `query` reads the files and is the only way back past a \
                            restart. Filter by `thread` to follow one terminal, by `level` for \
                            this level and worse, by `since` for the last few minutes. Every \
                            record is already redacted, so what comes back can be pasted into \
                            an issue.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "description": "tail (memory, this host) or query (files, every host). Default query." },
                    "level": { "type": "string", "description": "This level and worse: trace, debug, info, warn, error." },
                    "host": { "type": "string", "description": "desktop, server, mcp or webview. Omit for all of them." },
                    "thread": { "type": "string", "description": "One terminal, by thread id." },
                    "turn": { "type": "string", "description": "One agent turn." },
                    "target": { "type": "string", "description": "A module prefix, such as boite_core::command." },
                    "text": { "type": "string", "description": "Case-insensitive, matched against the message and the fields." },
                    "since": { "type": "number", "description": "Unix milliseconds, inclusive." },
                    "until": { "type": "number", "description": "Unix milliseconds, inclusive." },
                    "limit": { "type": "number", "description": "How many records. Default 100, max 1000." }
                }
            },
            "annotations": { "title": "Logs", "readOnlyHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "workspace_search",
            "description": "Find text anywhere in this workspace: the todo list, the log of what                             agents did and were refused, and what the terminals printed. Use it                             before asking a human where something is, and before assuming a                             failure is new — the same error is often already in another                             terminal or already in the log with the reason attached.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "q": { "type": "string", "description": "What to look for. A path, an error code, a branch name." },
                    "limit": { "type": "number", "description": "How many hits. Default 20, max 100." }
                },
                "required": ["q"]
            },
            "annotations": { "title": "Search", "readOnlyHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "terminal_transcript",
            "description": "What a terminal actually printed, read back from the end. Any thread in                             this workspace, not only your own: this is how you find out what                             another agent was doing when it stopped, and what its command really                             said before it failed. Ask workspace_snapshot for the thread ids.                             Defaults to your own terminal, which is how you re-read output you                             have lost track of. Escape sequences are stripped; a redrawn progress                             line stays as many lines.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "threadId": { "type": "string", "description": "Which terminal. Omit for your own." },
                    "bytes": { "type": "number", "description": "How much of the end to read. Default 16384, max 1048576." }
                }
            },
            "annotations": { "title": "Transcript", "readOnlyHint": true, "idempotentHint": false, "openWorldHint": false }
        },
        {
            "name": "worktree_branch",
            "description": "Create a NEW branch for the work in this terminal. Call it once the work \
                            is worth keeping: until then detached leaves no trace, and the worktree \
                            is discarded when the thread closes. Fails if the name is taken — use \
                            worktree_reserve for a branch that exists.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Branch name, in the convention the repository already uses (see worktree_status)." }
                },
                "required": ["name"],
                "additionalProperties": false
            },
            "annotations": { "title": "New branch", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "worktree_reserve",
            "description": "Move this terminal onto a branch that ALREADY exists, to continue it. \
                            Git allows a branch in one worktree at a time, so this fails if another \
                            terminal or the user's checkout holds it; the error says which.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "An existing local branch." }
                },
                "required": ["name"],
                "additionalProperties": false
            },
            "annotations": { "title": "Take branch", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "artifacts_status",
            "description": "What this project gives each new worktree out of the user's checkout: \
                            the heavy directories, how each one is shared, and what is left out of \
                            it. Also says whether the rule is declared by the project or guessed \
                            from its manifests — a guess is free to replace, a declared one was \
                            somebody's decision. Read this before artifacts_set.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Shared artifacts", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "artifacts_set",
            "description": "Declare what this project shares with its worktrees, replacing the whole \
                            rule. For a build system Boite does not recognise, or one whose layout \
                            it gets wrong. mode=link is one link over the whole directory, right for \
                            what only an install writes. mode=hardlink shares file by file and \
                            REQUIRES exclude to name everything the build rewrites: a hard link is \
                            not copy-on-write, so a build writing through one writes the main \
                            checkout's copy, and the user's own working tree ends up holding this \
                            terminal's output. Excludes are globs under the directory, `*` stopping \
                            at a separator and `**` not.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "shared": {
                        "type": "array",
                        "description": "The complete list. An empty one shares nothing at all.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "dir": { "type": "string", "description": "One directory at the top of the repository, by name: no path, no '..'." },
                                "mode": { "type": "string", "enum": ["link", "hardlink"], "description": "link for install directories, hardlink for build output." },
                                "exclude": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "Globs relative to dir, of everything the build rewrites. Ignored for link."
                                },
                                "cargoWorkspace": { "type": "boolean", "description": "Cargo only: read this repository's own packages from the manifests and exclude their artifacts, which no glob can express." }
                            },
                            "required": ["dir", "mode"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["shared"],
                "additionalProperties": false
            },
            "annotations": { "title": "Set shared artifacts", "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "projects_list",
            "description": "Every project in this Boite: id, name, folder, and whether it is \
                            archived. Archived ones are listed because a project the user put away \
                            is still the right place to go back to. Read before thread_move or \
                            project_create.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Projects", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        }
    ])
}

/// They act on this terminal's own workspace: they move this process, start
/// another one, or put something on the screen beside it.
fn thread_tools() -> Value {
    json!([
        {
            "name": "thread_move",
            "description": "Move THIS terminal into another project. Boite kills the process, \
                            carries the conversation to the new folder, opens a worktree there and \
                            brings you back up resumed. You will not read this result: the terminal \
                            that called it goes down first, and your next turn happens over there. \
                            A worktree still holding uncommitted work is left behind, not deleted. \
                            Leaving the project you are in is the user's call: `state: \
                            waiting-on-user` means the call worked and is queued for them, not that \
                            it was refused.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Id, name or folder, from projects_list." },
                    "note": { "type": "string", "description": "What to tell you on arrival. Omitted, Boite writes it." }
                },
                "required": ["project"],
                "additionalProperties": false
            },
            "annotations": { "title": "Move thread", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "project_create",
            "description": "Give this conversation a home: folder, git init, a project, and by \
                            default this terminal moved into it. For a thread that started outside \
                            any project (Scratch, the user's home folder) on an idea worth \
                            building. A project already there is reused, an archived one is brought \
                            back, a folder with files in it is refused unless you pass adopt. You \
                            will not read this result when it moves you. A new project is the \
                            user's call: `state: waiting-on-user` means the call worked and is \
                            queued for them, not that it was refused.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "What the project is called." },
                    "path": { "type": "string", "description": "Exact folder. Omitted, Boite puts it beside the user's other projects." },
                    "parent": { "type": "string", "description": "Folder to create it in, when you know where but not what to call it." },
                    "adopt": { "type": "boolean", "description": "Take over a folder that already has files. Off by default." },
                    "git": { "type": "boolean", "description": "Run git init. On by default; an existing repository is left alone." },
                    "move": { "type": "boolean", "description": "Move this terminal into it. On by default." },
                    "note": { "type": "string", "description": "What to tell you on arrival." }
                },
                "required": ["name"],
                "additionalProperties": false
            },
            "annotations": { "title": "New project", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "thread_spawn",
            "description": "Open another agent terminal, here or in another project, for work that \
                            should run in parallel in its own worktree — not for a sub-task you \
                            could do this turn. Answers with its threadId. Read what it printed \
                            with terminal_transcript, and wait for it with thread_wait. In this \
                            project it opens at once; in another one it is the user's call, and \
                            `state: waiting-on-user` means the call worked and is queued for them, \
                            not that it was refused.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent": { "type": "string", "description": "claude, codex, opencode, cursor, copilot, grok, hermes, antigravity, pi, muse, or one of the user's shortcut labels. For fastpick agents, use the format 'fastpick:provider:model' (e.g., 'fastpick:crof:deepseek-v4-pro'), or 'fastpick:provider.key:model' to name one credential of a provider that holds several. A harness in front of the provider picks which agent runs on that endpoint: 'fastpick:pi:crof:deepseek-v4-pro', one of claude-code, opencode, codex or pi, claude-code when the name omits it. Defaults to yours." },
                    "project": { "type": "string", "description": "Id, name or folder. Defaults to this project." },
                    "prompt": {
                        "type": "string",
                        "description": "Its opening instruction, written for someone who was not in \
                                        this conversation. claude, codex, pi, grok and antigravity \
                                        take one on the command line; the rest get it typed and \
                                        submitted once the terminal is up."
                    }
                },
                "additionalProperties": false
            },
            "annotations": { "title": "New thread", "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "thread_close",
            "description": "Close a terminal you spawned, once you have read what you needed from \
                            it. Do this every time: a worker nobody closes stays in the user's \
                            sidebar forever, and the ones you opened are yours to put away. Only \
                            your own workers, and only when the worker has stopped — a running \
                            one or one sitting on a permission dialog is refused, so wait for it \
                            with thread_wait first. The terminal goes, and its detached worktree \
                            with it, so claim a branch before closing anything that wrote code.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "threadId": { "type": "string", "description": "The thread id thread_spawn answered with." }
                },
                "required": ["threadId"],
                "additionalProperties": false
            },
            "annotations": { "title": "Close thread", "destructiveHint": true, "openWorldHint": false }
        },
        {
            "name": "pane_open",
            "description": "Put something on screen next to this terminal, in a split pane. Use it                             when you have just made something worth looking at: a dev server                             (browser), a diff you want reviewed (git), the file tree after a big                             move (explorer), the project's state (dashboard). The user keeps your                             terminal in view either way. Opening a pane that is already open just                             focuses it, so calling twice is safe and does nothing the second time.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["dashboard", "git", "explorer", "todo", "editor", "browser"],
                        "description": "What to show."
                    },
                    "url": {
                        "type": "string",
                        "description": "For kind=browser. A dev server on this machine is the case                                         this exists for: plain http:// reaches localhost, 127.0.0.1,                                         [::1] and 0.0.0.0 and nowhere else, and everywhere else                                         needs https://. Boite's own address is refused, and a page                                         off this machine waits for the user to agree before it is                                         shown. A public site may also refuse to be framed, and the                                         user gets a button to open it outside."
                    },
                    "path": {
                        "type": "string",
                        "description": "For kind=editor. The file to open. The explorer opens at the thread's own directory and takes no path."
                    },
                    "side": {
                        "type": "string",
                        "enum": ["left", "right", "top", "bottom"],
                        "description": "Which side of this terminal. Defaults to right."
                    }
                },
                "required": ["kind"],
                "additionalProperties": false
            },
            "annotations": { "title": "Open pane", "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false }
        },
        {
            "name": "thread_wait",
            "description": "A sibling terminal's status. timeoutMs waits until it is no longer live, \
                            up to 30s. Use the threadId from thread_spawn.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "threadId": { "type": "string" },
                    "timeoutMs": { "type": "number", "description": "0 (default) answers now; max 30000." }
                },
                "required": ["threadId"],
                "additionalProperties": false
            },
            "annotations": { "title": "Wait for thread", "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "browser",
            "description": "Drive a browser pane you opened. action=status lists panes; snapshot \
                            reads the page (mode=text|diff|elements); click/type/press/scroll act \
                            on a uid from snapshot; navigate/reload/wait_for/close/screenshot move \
                            the pane. Desktop window only for read and drive.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "snapshot", "screenshot", "click", "type", "press",
                                 "scroll", "navigate", "reload", "wait_for", "close"]
                    },
                    "paneId": { "type": "string" },
                    "url": { "type": "string" },
                    "uid": { "type": "string" },
                    "text": { "type": "string" },
                    "key": { "type": "string" },
                    "mode": { "type": "string", "enum": ["elements", "diff", "text"] },
                    "maxChars": { "type": "integer" },
                    "timeoutMs": { "type": "integer" },
                    "dy": { "type": "number" },
                    "double": { "type": "boolean" },
                    "clear": { "type": "boolean" },
                    "submit": { "type": "boolean" }
                },
                "required": ["action"],
                "additionalProperties": false
            },
            "annotations": { "title": "Browser", "openWorldHint": true }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        tools()
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()).map(str::to_string))
            .collect()
    }

    #[test]
    fn tools_list_has_no_separate_browser_drive_tools() {
        let names = names();
        for old in [
            "browser_status",
            "browser_snapshot",
            "browser_screenshot",
            "browser_click",
            "browser_type",
            "browser_press",
            "browser_scroll",
            "browser_navigate",
            "browser_reload",
            "browser_wait_for",
            "browser_close",
        ] {
            assert!(!names.iter().any(|n| n == old), "{old} still advertised");
        }
        assert!(names.iter().any(|n| n == "browser"), "{names:?}");
        assert!(names.iter().any(|n| n == "whereami"), "{names:?}");
        assert!(names.iter().any(|n| n == "thread_wait"), "{names:?}");
        assert_eq!(names.len(), 22, "{names:?}");
    }

    /// Pinned like the count above: the orchestrator tier is four tools, an
    /// ordinary thread never sees them, and an unknown role is an ordinary
    /// thread rather than a wider one.
    #[test]
    fn the_orchestrator_tier_is_four_tools_nobody_else_sees() {
        let plain: Vec<String> = tools_for_role(None)
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        assert_eq!(plain.len(), 22, "{plain:?}");
        assert!(!plain.iter().any(|n| n == "workspace_pulse"));
        assert!(!plain.iter().any(|n| n == "say"));
        assert!(!plain.iter().any(|n| n == "thread_dispatch"));
        assert!(!plain.iter().any(|n| n == "thread_dismiss"));
        assert_eq!(tools_for_role(Some("supervisor")).as_array().unwrap().len(), 22);

        let raised: Vec<String> = tools_for_role(Some("orchestrator"))
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        assert_eq!(raised.len(), 26, "{raised:?}");
        assert!(raised.iter().any(|n| n == "workspace_pulse"));
        assert!(raised.iter().any(|n| n == "say"));
        assert!(raised.iter().any(|n| n == "thread_dispatch"));
        assert!(raised.iter().any(|n| n == "thread_dismiss"));

        assert!(instructions_for_role(Some("orchestrator"), None).contains("workspace_pulse"));
        assert!(!instructions_for_role(None, None).contains("orchestrator"));

        // The scoped opening names its project and drops the workspace claim;
        // the craft below the opening is the same text either way.
        let scoped = instructions_for_role(Some("orchestrator"), Some("p1"));
        assert!(scoped.contains("project p1's orchestrator"), "{scoped}");
        assert!(!scoped.contains("workspace's orchestrator"), "{scoped}");
        assert!(scoped.contains("workspace_pulse"));
        assert!(instructions_for_role(None, Some("p1")) == instructions_for_role(None, None));
    }

    /// Configuration sync is not something an agent may reach, and the reason it
    /// cannot is that nothing here names it — not the capability check, which
    /// `Grant::Owner` passes.
    ///
    /// Three of the calls write into `~/.gemini/config/mcp_config.json`, which
    /// decides which MCP servers an agent may talk to, and into `~/.agents`,
    /// which is the instruction tree every agent on the machine reads and which
    /// this feature then pushes to a git remote and onto every other computer
    /// the user owns. An agent that could write those could grant itself tools
    /// and write its own future instructions, everywhere, at once.
    ///
    /// Reading is left out too. It is harmless on its own, and a tool list is
    /// paid for in every session that connects and again in the context window
    /// that reads it — for an answer no agent workflow needs.
    ///
    /// Deleting this test to add one is the point: it should take a sentence
    /// saying why.
    #[test]
    fn no_sync_tool_is_offered_to_an_agent() {
        for name in names() {
            assert!(!name.contains("sync"), "{name} puts configuration sync in reach of an agent");
        }
    }

    /// Telemetry consent, export and forget are `Grant::Local`. An agent that
    /// saw a tool named after them would try, get refused, and still learn
    /// that the methods exist. The bus already blocks `Grant::Owner`; this
    /// keeps the tool list from advertising the door.
    #[test]
    fn no_telemetry_tool_is_offered_to_an_agent() {
        for name in names() {
            assert!(
                !name.contains("telemetry"),
                "{name} puts telemetry in reach of an agent"
            );
        }
    }
}

