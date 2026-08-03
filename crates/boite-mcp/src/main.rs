//! MCP server exposing the todo list of the Boite terminal it was launched in.
//!
//! It holds no configuration and no credentials of its own. Boite stamps
//! `BOITE_MCP_URL`, `BOITE_TOKEN_FILE` and `BOITE_THREAD_ID` into every PTY it
//! spawns, so this reads its whole identity from the environment. Launched
//! anywhere else, those variables are absent and it refuses to start — which is
//! the point: an agent outside Boite has nothing to present.
//!
//! The token arrives as a path rather than a value, because an environment is
//! something a terminal prints: `BOITE_TOKEN` put the credential into the
//! output of any `env` an agent typed, and that output is kept and replayed.
//!
//! The same binary serves the desktop app and `boite-server`; only the URL in
//! the environment differs, so a remote workspace needs no separate shim.
//!
//! Everything it says goes out in TOON (`toon.rs`) rather than JSON. The tool
//! list is paid for in every session that connects, and each answer is paid for
//! again in the context window that reads it, so both are written to be short:
//! one line per tool, one row per todo, and ids shortened to the prefix that
//! still distinguishes them.

mod http;
mod toon;

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde_json::{json, Value};

use http::Endpoint;

use toon::{clip, Toon};

/// Newest version this speaks. A client asking for an older one gets that one
/// back — the shape of these five tools has not changed across any of them, and
/// answering with a version the client did not offer ends the handshake.
const LATEST_PROTOCOL: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// A todo's title is one line by convention and a pasted paragraph in practice,
/// and its description is a paragraph on purpose.
const MAX_CELL: usize = 200;
/// Branch lists grow without bound in a long-lived repository; the agent needs
/// the naming convention and the few most recent, not all of them.
const MAX_BRANCHES: usize = 40;

struct Host {
    endpoint: Endpoint,
    token: String,
    /// The thread this shim was spawned for, when Boite launched the agent.
    thread_id: Option<String>,
    /// The project, when credentials came from a file instead. Agents that do
    /// not pass their environment to a server process can only be reached this
    /// way — the endpoint takes either, and resolves both to one project.
    project_id: Option<String>,
    /// Which agent this is, when the registration said so. Only ever used to
    /// put the right badge on a claim; it grants nothing.
    agent: Option<String>,
    /// Short id to full id, filled by every listing. The process lives as long
    /// as the agent does, so a claim can quote the eight characters it was
    /// shown instead of a full uuid. Single-threaded loop, hence `RefCell`.
    ids: RefCell<HashMap<String, String>>,
}

#[derive(serde::Deserialize)]
struct Credentials {
    url: String,
    token: String,
    #[serde(rename = "projectId")]
    project_id: String,
}

/// Percent-encodes a path so it survives as an HTTP header value.
///
/// A header value is visible ASCII, and a directory is not: an accented path
/// would fail the whole request rather than just the lookup it feeds. Encoding
/// beats skipping the header on those paths, which would have left exactly the
/// users with non-ASCII directories on the old per-project behaviour.
fn encode_header_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl Host {
    /// Environment first, then the credentials file named on the command line.
    ///
    /// The environment is what Boite stamps into a terminal it launched, and it
    /// carries the thread — the most precise answer. The file exists for agents
    /// that hand a server process nothing but PATH, where the environment can
    /// never arrive; it names a project instead, which is the unit the list
    /// belongs to anyway.
    fn resolve() -> Result<Host, String> {
        if let (Ok(url), Some(token)) = (std::env::var("BOITE_MCP_URL"), Self::token_from_env()) {
            let thread_id = std::env::var("BOITE_THREAD_ID").ok().filter(|s| !s.is_empty());
            if thread_id.is_some() {
                return Ok(Host {
                    endpoint: Endpoint::parse(&url)?,
                    token,
                    thread_id,
                    project_id: None,
                    // The thread names the agent better than any argument could:
                    // Boite launched it and knows what it is.
                    agent: None,
                    ids: RefCell::new(HashMap::new()),
                });
            }
        }

        let path = std::env::args().nth(1).ok_or_else(|| {
            "no Boite credentials: run this from a Boite terminal, or pass the \
             credentials file the Todo panel offers"
                .to_string()
        })?;
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read credentials at {path}: {e}"))?;
        let creds: Credentials =
            serde_json::from_str(&text).map_err(|e| format!("bad credentials file: {e}"))?;
        // The Todo panel writes the agent's own name into the line it offers,
        // because it knows which row the button was under. Without it a claim
        // arrives from "some agent" and the list can only show a generic mark.
        let agent = std::env::args().nth(2).filter(|s| !s.is_empty());
        Ok(Host {
            endpoint: Endpoint::parse(&creds.url)?,
            token: creds.token,
            thread_id: None,
            project_id: Some(creds.project_id),
            agent,
            ids: RefCell::new(HashMap::new()),
        })
    }

    /// The bearer token for a terminal Boite spawned.
    ///
    /// `BOITE_TOKEN_FILE` names a file only this user can read; the value used
    /// to be in `BOITE_TOKEN` itself, which meant an agent typing `env` printed
    /// its own credential into a scrollback that is kept and replayed. That
    /// variable is still read, and only for one reason: a terminal opened
    /// before the app was updated is still running with the old environment,
    /// and its agent should not lose its todo list mid-session.
    fn token_from_env() -> Option<String> {
        if let Ok(path) = std::env::var("BOITE_TOKEN_FILE") {
            if !path.trim().is_empty() {
                return std::fs::read_to_string(&path)
                    .ok()
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty());
            }
        }
        std::env::var("BOITE_TOKEN").ok().filter(|t| !t.is_empty())
    }

    fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let auth = format!("Bearer {}", self.token);
        // Only ever alongside a project: a thread already names one exactly.
        // Bound before the header list so it outlives the borrows in it.
        let cwd = self.project_id.as_ref().and_then(|_| {
            std::env::current_dir()
                .ok()
                .and_then(|p| p.to_str().map(encode_header_path))
        });
        let mut headers: Vec<(&str, &str)> = vec![("Authorization", &auth)];
        if let Some(thread) = &self.thread_id {
            headers.push(("x-boite-thread", thread));
        }
        if let Some(project) = &self.project_id {
            headers.push(("x-boite-project", project));
        }
        // What lets one registration serve every project: the file names the
        // project it was made from, this names the one the agent is actually
        // in. The endpoint decides whether any project claims it.
        if let Some(cwd) = &cwd {
            headers.push(("x-boite-cwd", cwd));
        }
        if let Some(agent) = &self.agent {
            headers.push(("x-boite-agent", agent));
        }
        let body = body.map(|b| b.to_string().into_bytes());
        let res = self.endpoint.send(method, path, &headers, body)?;
        let status = res.status;
        if status == 409 {
            // The endpoint refuses without saying which reason applied; say the
            // same here rather than inventing a diagnosis. The two routes mean
            // different things by it, and telling an agent its todo is closed
            // when the real answer is "you have no worktree" sends it looking
            // in the wrong place entirely.
            return Err(if path.starts_with("/v1/worktree") {
                "this terminal has no worktree: it runs directly in the project folder, \
                 so branches here are the user's to make"
                    .into()
            } else {
                "that item is not open, or does not belong to this project".to_string()
            });
        }
        if !(200..300).contains(&status) {
            return Err(format!("boite refused the call ({status})"));
        }
        serde_json::from_slice(&res.body).map_err(|e| format!("bad response: {e}"))
    }

    fn remember(&self, short: &str, full: &str) {
        self.ids
            .borrow_mut()
            .insert(short.to_string(), full.to_string());
    }

    /// The full id behind whatever the agent quoted.
    ///
    /// A short id it saw in a listing this process made resolves from memory. A
    /// short id it saw before a restart does not, so the list is fetched once
    /// and asked again — one extra round trip on a path that would otherwise
    /// fail with a refusal the agent cannot act on. Anything else goes through
    /// untouched: a full uuid out of a task prompt is already the answer.
    fn full_id(&self, given: &str) -> String {
        if let Some(full) = self.ids.borrow().get(given) {
            return full.clone();
        }
        if given.len() >= 32 {
            return given.to_string();
        }
        if let Ok(out) = self.send("GET", "/v1/todos", None) {
            index_todos(self, &out);
        }
        self.ids
            .borrow()
            .get(given)
            .cloned()
            .unwrap_or_else(|| given.to_string())
    }
}

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
const INSTRUCTIONS: &str = "\
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

fn tools(_host: Option<&Host>) -> Value {
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

/// The shortest prefix that still tells these ids apart. Uuids collide at eight
/// characters about as often as they collide outright, but a list is small and
/// checking costs nothing, so widen rather than hand out an ambiguous id.
fn short_width(ids: &[&str]) -> usize {
    for width in [8usize, 13, 18] {
        let mut seen: Vec<&str> = ids.iter().map(|id| prefix(id, width)).collect();
        let total = seen.len();
        seen.sort_unstable();
        seen.dedup();
        if seen.len() == total {
            return width;
        }
    }
    usize::MAX
}

fn prefix(id: &str, width: usize) -> &str {
    id.get(..width).unwrap_or(id)
}

/// Record every id in a listing under its short form, so a later claim can
/// quote what it was shown. Returns the width that was handed out.
fn index_todos(host: &Host, out: &Value) -> usize {
    let empty = Vec::new();
    let todos = out
        .get("todos")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let ids: Vec<&str> = todos
        .iter()
        .filter_map(|t| t.get("id").and_then(|v| v.as_str()))
        .collect();
    let width = short_width(&ids);
    for id in ids {
        host.remember(prefix(id, width), id);
    }
    width
}

fn format_todos(host: &Host, out: &Value) -> String {
    let empty = Vec::new();
    let todos = out
        .get("todos")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let width = index_todos(host, out);
    let str_at = |t: &Value, key: &str| {
        t.get(key)
            .and_then(|v| v.as_str())
            .map(|s| clip(s, MAX_CELL))
            .unwrap_or_default()
    };
    let rows: Vec<Vec<String>> = todos
        .iter()
        .map(|t| {
            let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            vec![
                prefix(id, width).to_string(),
                str_at(t, "state"),
                str_at(t, "title"),
                str_at(t, "description"),
                str_at(t, "note"),
            ]
        })
        .collect();

    // A column that says the same thing on every row, or nothing on any of
    // them, is paid for once per row and answers nothing. A list where every
    // item is still open — which is most lists — says so on one line instead.
    let uniform_state = rows
        .first()
        .map(|r| r[1].clone())
        .filter(|first| rows.iter().all(|r| &r[1] == first));
    let any_description = rows.iter().any(|r| !r[3].is_empty());
    let any_note = rows.iter().any(|r| !r[4].is_empty());
    let mut cols: Vec<&str> = vec!["id"];
    if uniform_state.is_none() {
        cols.push("state");
    }
    cols.push("title");
    if any_description {
        cols.push("description");
    }
    if any_note {
        cols.push("note");
    }
    let rows: Vec<Vec<String>> = rows
        .into_iter()
        .map(|r| {
            let [id, state, title, description, note] = r.try_into().expect("five columns");
            let mut kept = vec![id];
            if uniform_state.is_none() {
                kept.push(state);
            }
            kept.push(title);
            if any_description {
                kept.push(description);
            }
            if any_note {
                kept.push(note);
            }
            kept
        })
        .collect();

    let mut w = Toon::new();
    if let Some(state) = &uniform_state {
        w.field("state", &format!("{state} (every item)"));
    }
    w.table("todos", &cols, &rows);
    if rows.is_empty() {
        w.hint("nothing on this project's list: todo_add title=<one line>");
    } else {
        w.hint("todo_claim id=<id> note=<what changed> — the user confirms, not you");
    }
    w.into_string()
}

fn format_worktree(out: &Value) -> String {
    let string_at = |key: &str| out.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let branches: Vec<String> = out
        .get("branches")
        .and_then(|v| v.as_array())
        .map(|b| {
            b.iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let detached = out
        .get("detached")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let dirty = out
        .get("uncommittedChanges")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut w = Toon::new();
    w.field("path", string_at("path"))
        .field("repo", string_at("repo"))
        .field("branch", string_at("branch"))
        .flag("detached", detached)
        .flag("uncommitted", dirty)
        .inline("branches", &branches, MAX_BRANCHES);
    if detached {
        w.hint("worktree_branch name=<new> once the work is worth keeping");
    }
    w.into_string()
}

/// The sharing rule, one row per directory.
///
/// `source` comes first and is the point of the whole answer: the rows read the
/// same either way, and only that line tells the agent whether it is looking at
/// a decision or at a guess it is free to replace.
fn format_artifacts(out: &Value) -> String {
    let empty = Vec::new();
    let shared = out.get("shared").and_then(|v| v.as_array()).unwrap_or(&empty);
    let declared = out.get("declared").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut any_cargo = false;
    let rows: Vec<Vec<String>> = shared
        .iter()
        .map(|e| {
            let string_at = |key: &str| e.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let cargo = e
                .get("cargoWorkspace")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            any_cargo |= cargo;
            // The globs go in one cell, comma-separated: a row per glob would
            // repeat the directory, and this list is read as a whole anyway.
            let exclude = e
                .get("exclude")
                .and_then(|v| v.as_array())
                .map(|g| {
                    g.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            vec![
                string_at("dir"),
                string_at("mode"),
                clip(&exclude, MAX_CELL),
                if cargo { "yes".into() } else { String::new() },
            ]
        })
        .collect();

    // The cargo rule is off on all but one project in a hundred, and a column
    // that is empty on every row is paid for on every row.
    let mut cols: Vec<&str> = vec!["dir", "mode", "exclude"];
    if any_cargo {
        cols.push("cargoWorkspace");
    }
    let rows: Vec<Vec<String>> = rows
        .into_iter()
        .map(|mut r| {
            if !any_cargo {
                r.pop();
            }
            r
        })
        .collect();

    let mut w = Toon::new();
    w.field("source", if declared { "declared" } else { "detected" })
        .field("file", out.get("file").and_then(|v| v.as_str()).unwrap_or(""))
        .table("shared", &cols, &rows);
    if declared {
        w.hint("the project declared this; artifacts_set replaces the whole list");
    } else {
        w.hint("nothing is declared: this is guessed from the manifests, artifacts_set to fix it");
    }
    w.into_string()
}

fn call_tool(host: &Host, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "todo_list" => {
            let out = host.send("GET", "/v1/todos", None)?;
            Ok(format_todos(host, &out))
        }
        "todo_add" => {
            // `text` is still read: a model that learnt the old single-field
            // shape from a cached tool list would otherwise get a refusal it
            // cannot act on, and the title is the same string either way.
            let title = args
                .get("title")
                .or_else(|| args.get("text"))
                .and_then(|v| v.as_str())
                .ok_or("todo_add needs a title")?;
            let description = args.get("description").and_then(|v| v.as_str());
            let out = host.send(
                "POST",
                "/v1/todos",
                Some(json!({ "title": title, "description": description })),
            )?;
            let id = out.get("id").and_then(|v| v.as_str()).unwrap_or("?");
            let short = prefix(id, 8);
            host.remember(short, id);
            let mut w = Toon::new();
            w.field("added", short);
            Ok(w.into_string())
        }
        "todo_claim" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("todo_claim needs an id")?;
            let full = host.full_id(id);
            let note = args.get("note").and_then(|v| v.as_str());
            let commit = args.get("commit").and_then(|v| v.as_str());
            host.send(
                "POST",
                "/v1/todos/claim",
                Some(json!({ "id": full, "note": note, "commit": commit })),
            )?;
            let mut w = Toon::new();
            w.field("reported", prefix(&full, 8))
                .field("state", "awaiting-user");
            Ok(w.into_string())
        }
        "worktree_status" => {
            let out = host.send("GET", "/v1/worktree", None)?;
            Ok(format_worktree(&out))
        }
        "worktree_branch" => branch_call(host, args, "/v1/worktree/branch", "worktree_branch"),
        "worktree_reserve" => branch_call(host, args, "/v1/worktree/reserve", "worktree_reserve"),
        "artifacts_status" => {
            let out = host.send("GET", "/v1/artifacts", None)?;
            Ok(format_artifacts(&out))
        }
        "artifacts_set" => {
            let shared = args
                .get("shared")
                .and_then(|v| v.as_array())
                .ok_or("artifacts_set needs shared, the complete list of directories")?;
            // Forwarded as it came: every field is the endpoint's to validate,
            // and a name it refuses comes back as a sentence rather than as a
            // shape this shim guessed at.
            let out = refusable(host, "/v1/artifacts", json!({ "shared": shared }))?;
            let names: Vec<String> = shared
                .iter()
                .filter_map(|e| e.get("dir").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect();
            let mut w = Toon::new();
            w.field("declared", out.get("file").and_then(|v| v.as_str()).unwrap_or("-"))
                .inline("shares", &names, MAX_BRANCHES)
                .hint("it applies to worktrees opened from now on, not to this one");
            Ok(w.into_string())
        }
        "projects_list" => {
            let out = host.send("GET", "/v1/projects", None)?;
            Ok(format_projects(&out))
        }
        "thread_move" => {
            let project = args
                .get("project")
                .and_then(|v| v.as_str())
                .ok_or("thread_move needs a project")?;
            let out = refusable(
                host,
                "/v1/thread/move",
                json!({ "project": project, "note": args.get("note").and_then(|v| v.as_str()) }),
            )?;
            let name = out.get("project").and_then(|v| v.as_str()).unwrap_or(project);
            // Written for a reader that will almost certainly never exist: the
            // terminal goes down before an agent gets to read it. Worth the
            // three fields anyway, for a move that fails late enough that this
            // stays on screen.
            let mut w = Toon::new();
            w.field("moving-to", name)
                .field("terminal", "restarting there")
                .hint("your next turn happens in the new folder, with this conversation resumed");
            Ok(w.into_string())
        }
        "project_create" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or("project_create needs a name")?;
            let mut body = json!({ "name": name });
            // Forwarded only when given, so the endpoint's own defaults apply
            // rather than being overwritten with nulls.
            for key in ["path", "parent", "note"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                    body[key] = json!(v);
                }
            }
            for key in ["adopt", "git", "move"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_bool()) {
                    body[key] = json!(v);
                }
            }
            let moving = args.get("move").and_then(|v| v.as_bool()).unwrap_or(true);
            refusable(host, "/v1/projects", body)?;
            let mut w = Toon::new();
            w.field("creating", name).flag("moves-this-terminal", moving);
            if moving {
                w.hint("your next turn happens in the new folder, with this conversation resumed");
            }
            Ok(w.into_string())
        }
        "thread_spawn" => {
            let mut body = json!({});
            for key in ["agent", "project", "prompt"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                    body[key] = json!(v);
                }
            }
            refusable(host, "/v1/threads", body)?;
            let mut w = Toon::new();
            w.field("opened", args.get("agent").and_then(|v| v.as_str()).unwrap_or("agent"))
                .hint("it runs on its own: no report back, and you cannot read its output");
            Ok(w.into_string())
        }
        "pane_open" => {
            let mut body = json!({});
            for key in ["kind", "url", "side"] {
                if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                    body[key] = json!(v);
                }
            }
            refusable(host, "/v1/pane/open", body)?;
            let mut w = Toon::new();
            w.field("opened", args.get("kind").and_then(|v| v.as_str()).unwrap_or("pane"));
            if let Some(url) = args.get("url").and_then(|v| v.as_str()) {
                w.field("url", url);
            }
            w.hint("the user sees it now; you cannot read what is in it, and a page off this machine waits on them agreeing to it");
            Ok(w.into_string())
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

/// The project list, one row each. The path is what an agent matches against
/// its own cwd, so it is never clipped away; the name is what a user says out
/// loud, and both are accepted by `thread_move`.
fn format_projects(out: &Value) -> String {
    let empty = Vec::new();
    let projects = out
        .get("projects")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);
    let mut any_archived = false;
    let rows: Vec<Vec<String>> = projects
        .iter()
        .map(|p| {
            let string_at = |key: &str| {
                p.get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let flag_at = |key: &str| p.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
            let archived = flag_at("archived");
            any_archived |= archived;
            vec![
                string_at("id"),
                clip(&string_at("name"), MAX_CELL),
                clip(&string_at("path"), MAX_CELL),
                match (flag_at("current"), archived) {
                    (true, _) => "here".into(),
                    (_, true) => "archived".into(),
                    _ => "-".into(),
                },
            ]
        })
        .collect();

    let mut w = Toon::new();
    w.table("projects", &["id", "name", "path", "note"], &rows);
    if any_archived {
        w.hint("an archived project is unarchived by moving into it, never duplicated");
    } else {
        w.hint("thread_move project=<id|name|path>, or project_create name=<new>");
    }
    w.into_string()
}

/// A POST whose refusals arrive as a 200 carrying an `error`.
///
/// The endpoint answers that way whenever the reason is the agent's to act on —
/// a project that does not exist, a name that matches two of them. A transport
/// failure is something else and stays a transport failure.
fn refusable(host: &Host, path: &str, body: Value) -> Result<Value, String> {
    let out = host.send("POST", path, Some(body))?;
    if let Some(err) = out.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(out)
}

/// Both branch tools take one name and answer the same three ways: it worked,
/// git would not, or this terminal has no worktree to put a branch on.
fn branch_call(host: &Host, args: &Value, path: &str, tool: &str) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{tool} needs a name"))?;
    let out = host.send("POST", path, Some(json!({ "name": name })))?;
    // The endpoint answers 200 with an `error` field for a refusal git made, so
    // the agent reads the reason and picks another name instead of seeing a
    // transport failure it cannot act on.
    if let Some(err) = out.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    let mut w = Toon::new();
    w.field("branch", name).field("terminal", "attached");
    Ok(w.into_string())
}

fn reply(out: &mut impl Write, id: &Value, result: Value) {
    let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}

/// Tool failures come back as a result with `isError`, not as a JSON-RPC error:
/// the call reached the tool and the agent should read what went wrong and
/// adapt. Protocol-level errors are a different thing and stay rare.
fn reply_tool_error(out: &mut impl Write, id: &Value, message: &str) {
    reply(
        out,
        id,
        json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
    );
}

/// Answer in the version the client asked for when it is one this speaks, and
/// in the newest one otherwise. A client that offers nothing gets the newest —
/// which is what the specification asks a server to do.
fn negotiate(params: &Value) -> &'static str {
    let asked = params.get("protocolVersion").and_then(|v| v.as_str());
    asked
        .and_then(|a| SUPPORTED_PROTOCOLS.into_iter().find(|s| *s == a))
        .unwrap_or(LATEST_PROTOCOL)
}

fn main() {
    // Resolved but not required. Exiting here would kill the connection during
    // the handshake, and a client can only report that as "connection closed" —
    // hiding a cause that is one sentence long. Answering initialize and failing
    // at the call instead puts that sentence in front of the agent, which is the
    // only place anyone will read it.
    let host = Host::resolve();

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        // Notifications carry no id and expect no answer.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };

        match method {
            "initialize" => {
                let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
                reply(
                    &mut stdout,
                    &id,
                    json!({
                        "protocolVersion": negotiate(&params),
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "boite", "version": env!("CARGO_PKG_VERSION") },
                        "instructions": INSTRUCTIONS
                    }),
                )
            }
            "tools/list" => reply(&mut stdout, &id, json!({ "tools": tools(host.as_ref().ok()) })),
            "tools/call" => {
                let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let called = match &host {
                    Ok(h) => call_tool(h, name, &args),
                    Err(e) => Err(e.clone()),
                };
                match called {
                    Ok(text) => reply(
                        &mut stdout,
                        &id,
                        json!({ "content": [{ "type": "text", "text": text }] }),
                    ),
                    Err(e) => reply_tool_error(&mut stdout, &id, &e),
                }
            }
            "ping" => reply(&mut stdout, &id, json!({})),
            other => {
                let msg = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("method not found: {other}") }
                });
                let _ = writeln!(stdout, "{msg}");
                let _ = stdout.flush();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Host {
        Host {
            endpoint: Endpoint::parse("http://127.0.0.1:1").unwrap(),
            token: "t".into(),
            thread_id: Some("thread".into()),
            project_id: None,
            agent: None,
            ids: RefCell::new(HashMap::new()),
        }
    }

    #[test]
    fn a_listing_costs_a_row_per_todo() {
        let h = host();
        let out = json!({ "todos": [
            { "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c", "projectId": "e7c778e0-6a14-4cfe-a7df-b9a2f5b04fc5",
              "title": "opti mcp axi", "state": "open", "note": null, "position": 0 },
            { "id": "596ce966-971c-4702-9040-1b1393ed8447", "projectId": "e7c778e0-6a14-4cfe-a7df-b9a2f5b04fc5",
              "title": "readme", "state": "claimed", "note": "done", "position": 1 }
        ]});
        assert_eq!(
            format_todos(&h, &out),
            "todos(2):\n  id state title note\n  1a5f3698 open \"opti mcp axi\" -\n  \
             596ce966 claimed readme done\nhint: todo_claim id=<id> note=<what changed> — the user confirms, not you\n"
        );
    }

    #[test]
    fn a_column_that_says_nothing_is_dropped() {
        let h = host();
        // Every item open, no note: two columns carry no information, and the
        // state they all share is worth one line rather than one cell per row.
        let out = json!({ "todos": [
            { "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c", "title": "opti mcp axi", "state": "open", "note": null },
            { "id": "596ce966-971c-4702-9040-1b1393ed8447", "title": "readme", "state": "open", "note": null }
        ]});
        assert_eq!(
            format_todos(&h, &out),
            concat!(
                "state: \"open (every item)\"\n",
                "todos(2):\n",
                "  id title\n",
                "  1a5f3698 \"opti mcp axi\"\n",
                "  596ce966 readme\n",
                "hint: todo_claim id=<id> note=<what changed> — the user confirms, not you\n",
            )
        );
    }

    #[test]
    fn a_description_earns_a_column_only_when_one_card_carries_it() {
        let h = host();
        // The panel keeps the description behind the card, but the agent that
        // has to act on it reads the list and nothing else.
        let out = json!({ "todos": [
            { "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c", "title": "opti mcp axi",
              "description": "drop reqwest", "state": "open", "note": null },
            { "id": "596ce966-971c-4702-9040-1b1393ed8447", "title": "readme", "state": "open", "note": null }
        ]});
        assert_eq!(
            format_todos(&h, &out),
            concat!(
                "state: \"open (every item)\"\n",
                "todos(2):\n",
                "  id title description\n",
                "  1a5f3698 \"opti mcp axi\" \"drop reqwest\"\n",
                "  596ce966 readme -\n",
                "hint: todo_claim id=<id> note=<what changed> — the user confirms, not you\n",
            )
        );
    }

    #[test]
    fn an_empty_list_says_so_and_offers_the_next_call() {
        let h = host();
        let out = format_todos(&h, &json!({ "todos": [] }));
        assert!(out.starts_with("todos(0): empty\n"));
        assert!(out.contains("todo_add"));
    }

    #[test]
    fn short_ids_resolve_to_the_full_one() {
        let h = host();
        index_todos(
            &h,
            &json!({ "todos": [{ "id": "1a5f3698-27dc-4f9d-90e5-d732c50e839c" }] }),
        );
        assert_eq!(h.full_id("1a5f3698"), "1a5f3698-27dc-4f9d-90e5-d732c50e839c");
    }

    #[test]
    fn a_full_id_goes_through_untouched() {
        let h = host();
        // Nothing indexed, and no endpoint to ask: a uuid is already the answer,
        // so this must not depend on a round trip.
        assert_eq!(
            h.full_id("1a5f3698-27dc-4f9d-90e5-d732c50e839c"),
            "1a5f3698-27dc-4f9d-90e5-d732c50e839c"
        );
    }

    #[test]
    fn ids_sharing_a_prefix_widen_instead_of_colliding() {
        let ids = [
            "1a5f3698-27dc-4f9d-90e5-d732c50e839c",
            "1a5f3698-99dc-4f9d-90e5-000000000000",
        ];
        assert_eq!(short_width(&ids), 13);
        assert_eq!(short_width(&["1a5f3698-a", "596ce966-b"]), 8);
        // Ids that differ only in the last group: no prefix separates them, so
        // the full id is handed out rather than an ambiguous one.
        let twins = [
            "1a5f3698-27dc-4f9d-90e5-d732c50e839c",
            "1a5f3698-27dc-4f9d-90e5-000000000000",
        ];
        assert_eq!(short_width(&twins), usize::MAX);
        assert_eq!(prefix(twins[0], usize::MAX), twins[0]);
    }

    #[test]
    fn worktree_status_is_six_lines() {
        let out = json!({
            "path": "C:\\worktrees\\3506",
            "repo": "D:\\Dev\\Collab\\boite",
            "branch": null,
            "detached": true,
            "uncommittedChanges": false,
            "branches": ["master", "feat/x"]
        });
        let text = format_worktree(&out);
        assert!(text.contains("branch: -\n"), "{text}");
        assert!(text.contains("detached: true\n"), "{text}");
        assert!(text.contains("uncommitted: false\n"), "{text}");
        assert!(text.contains("branches(2): master feat/x\n"), "{text}");
        assert!(text.contains("hint: worktree_branch"), "{text}");
    }

    /// A detected policy and a declared one differ in one line, and that line is
    /// what stops an agent from overwriting somebody's decision.
    #[test]
    fn the_artifact_policy_says_where_it_came_from() {
        let out = json!({
            "repo": "D:\\Dev\\Collab\\boite",
            "file": ".boite/artifacts.json",
            "declared": false,
            "shared": [
                { "dir": "target", "mode": "hardlink", "exclude": [], "cargoWorkspace": true },
                { "dir": "node_modules", "mode": "link", "exclude": [], "cargoWorkspace": false }
            ]
        });
        let text = format_artifacts(&out);
        assert!(text.contains("source: detected\n"), "{text}");
        assert!(text.contains("shared(2):\n"), "{text}");
        assert!(text.contains("  dir mode exclude cargoWorkspace\n"), "{text}");
        assert!(text.contains("  target hardlink - yes\n"), "{text}");
        assert!(text.contains("artifacts_set"), "{text}");

        let declared = json!({
            "file": ".boite/artifacts.json",
            "declared": true,
            "shared": [{ "dir": "_build", "mode": "hardlink", "exclude": ["dev/lib/mine/**"] }]
        });
        let text = format_artifacts(&declared);
        assert!(text.contains("source: declared\n"), "{text}");
        // No row asks for the cargo rule, so nobody pays for the column.
        assert!(text.contains("  dir mode exclude\n"), "{text}");
        assert!(text.contains("  _build hardlink dev/lib/mine/**\n"), "{text}");
    }

    #[test]
    fn the_protocol_answers_what_the_client_offered() {
        assert_eq!(negotiate(&json!({ "protocolVersion": "2024-11-05" })), "2024-11-05");
        assert_eq!(negotiate(&json!({ "protocolVersion": "1999-01-01" })), LATEST_PROTOCOL);
        assert_eq!(negotiate(&json!({})), LATEST_PROTOCOL);
    }
}
