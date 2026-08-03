//! What the agent is told it can do.
//!
//! Paid for in every session that connects and again in the context window that
//! reads it, so every line here is written to be short. The split between
//! `common_tools` and `thread_tools` is not cosmetic: an agent wired from a
//! credentials file has no terminal, so the tools that act on one would answer
//! it a refusal every time, and a tool that always refuses is worse than a tool
//! that is not there.

use serde_json::{json, Value};

use crate::host::Host;

/// The tool list, and the one place this shim spends tokens unconditionally:
/// every session that connects reads all of it before doing anything. Each
/// description says what the tool does and, where two tools are confusable,
/// which one the other case belongs to. Everything a failed call would explain
/// on its own is left to the failure.
///
/// `host` is unused now that every caller is a thread, and kept because
/// `tools/list` answers before any credential is needed: a shim with no host was
/// launched from a config file, and a config file is only ever written for a
/// project, so the answer is the same set either way.
/// Read once, at connection, before any tool is called.
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
pub(crate) const INSTRUCTIONS: &str = "\
You are running inside a Boite terminal. Boite is the user's workspace: several \
agent terminals side by side, one shared todo list per project, and a git \
worktree per terminal. The tools below reach that workspace, and nothing else \
you have reaches it.

Where you are. This terminal has its own detached worktree of the project: your \
own checkout, isolated from the user's and from the other terminals, sharing one \
history. So your edits are invisible in their working tree, and a detached \
worktree is discarded when the thread closes. Call worktree_status when you need \
to know where you are working and what branches exist.

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
it beside this terminal. Printing a path only works if they are reading this one.
- Independent work that should run at the same time: thread_spawn. It gets its \
own terminal and worktree, does not report back, and knows only the prompt you \
give it.

Answers are TOON: `key: value` for a single record, and `name(N):` followed by a \
header row then one row per item for a list.";

pub(crate) fn tools(_host: Option<&Host>) -> Value {
    let mut list = common_tools();
    if let (Some(all), Value::Array(tail)) = (list.as_array_mut(), thread_tools()) {
        all.extend(tail);
    }
    list
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
            "name": "worktree_status",
            "description": "Where this terminal works: its own detached worktree of the project, \
                            isolated from the user's checkout and from other terminals, sharing one \
                            history. Reports path, repo, branch if one was taken, uncommitted \
                            changes, and the existing branches.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Worktree", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
        },
        {
            "name": "workspace_snapshot",
            "description": "Everything Boite knows about itself right now, in one answer: every                             project and whether its folder is still there, every thread with what                             its row claims, and the terminals this workspace actually has a live                             process for. Read it before asking a human what they see. The two lists                             are the point — a thread whose status says running and whose id is not                             in livePtys is a dead terminal, and that comparison is not visible from                             anywhere else. Carries no secret, so it can be pasted into an issue.",
            "inputSchema": { "type": "object" },
            "annotations": { "title": "Snapshot", "readOnlyHint": true, "idempotentHint": true, "openWorldHint": false }
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

/// All three act: they move this process, or start another one.
fn thread_tools() -> Value {
    json!([
        {
            "name": "thread_move",
            "description": "Move THIS terminal into another project. Boite kills the process, \
                            carries the conversation to the new folder, opens a worktree there and \
                            brings you back up resumed. You will not read this result: the terminal \
                            that called it goes down first, and your next turn happens over there. \
                            A worktree still holding uncommitted work is left behind, not deleted.",
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
                            will not read this result when it moves you.",
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
                            could do this turn. It is independent: it does not report back and you \
                            cannot read its output, so the prompt is all it will know.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent": { "type": "string", "description": "claude, codex, opencode, cursor, copilot, grok, hermes, antigravity, or one of the user's shortcut labels. Defaults to yours." },
                    "project": { "type": "string", "description": "Id, name or folder. Defaults to this project." },
                    "prompt": {
                        "type": "string",
                        "description": "Its opening instruction, written for someone who was not in \
                                        this conversation. Only claude and codex take one on the \
                                        command line; ask for one of those if it must start knowing \
                                        something. The rest open bare and Boite shows the user what \
                                        was meant to be said."
                    }
                },
                "additionalProperties": false
            },
            "annotations": { "title": "New thread", "destructiveHint": false, "openWorldHint": false }
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
        }
    ])
}
