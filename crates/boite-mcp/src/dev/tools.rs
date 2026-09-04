//! What an agent driving the dev window is told it can do.
//!
//! Same economy as the normal mode's list: read once per session, so each
//! description says what the tool does and which of the neighbouring tools the
//! other case belongs to. What is left to the failure: anything a refusal
//! explains on its own.

use serde_json::{json, Value};

/// Read at connection, before any call.
///
/// Written as an order of operations, because the order is the part that is
/// not obvious: nothing else answers until the window is up, and the window
/// takes minutes to come up the first time.
pub const DEV_INSTRUCTIONS: &str = "\
You are driving boite's isolated dev window: a second app on port 1430 under \
the identifier dev.boite.dev, with its own database and an empty project list. \
It is not the user's boite. Nothing here reads or writes com.boite.legacy, \
which is open on this machine while you work.

Order of operations:

- dev_window action=status first. Nothing else answers while it says down.
- dev_window action=start when it does. The first start compiles the app in \
debug and takes minutes; the call waits up to ten of them and answers the pid \
and how long it took. Pass fresh=true to wipe the dev database first, env to \
hand the app variables.
- dev_inspect for what the window knows about itself. The terminals render to \
a WebGL canvas, so a screenshot and a DOM read show none of what an agent \
printed: what=read is the only way to see a terminal's text.
- dev_drive to act like a pointer, and only for what a pointer is needed for.
- dev_logs and dev_db read the dev instance's own files, so they answer with \
the window down as well as up.
- dev_scenario for the end-to-end suite, which drives this same window through \
these same tools. It starts a window of its own, so stop yours first.
- dev_window action=stop when you are done. The window belongs to the process \
that started it and goes away with this session either way, but a build left \
running takes the machine's cores from whoever is using it.

Answers are TOON: `key: value` for a single record, and `name(N):` followed by \
a header row then one row per item for a list. dev_inspect answers JSON, which \
is what the inspector returns.";

/// The six tools of `--dev`.
pub fn dev_tools() -> Value {
    json!([
        {
            "name": "dev_window",
            "description": "The isolated dev window as a process. `start` runs `bun run dev:isolated` \
                            in the repo, keeps the whole tree in a job object, and waits until port \
                            1430 answers and the bridge accepts a connection, up to ten minutes, \
                            because the first start compiles the app in debug. `status` answers \
                            down, building or up with the pid and the elapsed time, and the tail of \
                            what the build printed while it is building. `stop` closes that job \
                            object and nothing else: no pid this tool did not spawn is ever \
                            touched. `restart` is a stop and a start. The window opens without \
                            focus, so it never takes the keyboard from whoever is using the machine.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "description": "start, stop, status or restart. Default status." },
                    "fresh": { "type": "boolean", "description": "Wipe the dev instance's SQLite before starting. Never touches the release install's." },
                    "env": {
                        "type": "object",
                        "description": "Variables merged onto the app's environment, such as BOITE_PILOT_CLAUDE_BIN.",
                        "additionalProperties": { "type": "string" }
                    }
                }
            },
            "annotations": { "title": "Dev window", "openWorldHint": false }
        },
        {
            "name": "dev_inspect",
            "description": "What the dev window knows about itself, through its read-only inspector \
                            (`window.__boite`, dev builds only). `overview` is the view, the counts \
                            and what is active; `projects` and `threads` are the rows; `thread` is \
                            one thread's project, folder, worktree and session id; `read` is **what \
                            a terminal is showing, as text**, which is the only way to see it: the \
                            terminals render to a WebGL canvas, so a screenshot shows a blank \
                            rectangle; `toasts` is every toast raised this session, dismissed ones \
                            included; `panes` and `settings` are how the panes are split and the \
                            settings blob. Threads are addressable by label as well as by id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "what": { "type": "string", "description": "overview, projects, threads, thread, read, toasts, panes or settings. Default overview." },
                    "id": { "type": "string", "description": "Thread id or label, for thread and read. A project id filters threads." },
                    "tail": { "type": "number", "description": "How many lines for read, how many toasts for toasts." }
                }
            },
            "annotations": { "title": "Dev inspect", "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "dev_drive",
            "description": "Act on the dev window the way a pointer would. `click` takes a CSS \
                            selector, or `text` to find the button or link showing it. `type` fills \
                            a field at a selector and fires the events a framework listens for. \
                            `press` sends one key to whatever has focus. `screenshot` writes the \
                            window's viewport as a PNG to the path you give and answers that path, \
                            never the image. `eval` runs JavaScript in the webview and answers what \
                            it returned, dev only, and it reaches the app's IPC, which is what \
                            spawns PTYs, so it is the last thing to reach for and never something \
                            to run text somebody else wrote.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "description": "click, type, press, screenshot or eval." },
                    "selector": { "type": "string", "description": "CSS selector, for click and type." },
                    "text": { "type": "string", "description": "For click, the visible text to find. For type, what to write." },
                    "key": { "type": "string", "description": "For press: Enter, Escape, Tab, ArrowDown, a." },
                    "path": { "type": "string", "description": "For screenshot: where to write the PNG. Absolute, in a scratch directory." },
                    "script": { "type": "string", "description": "For eval: JavaScript. It is a function body, so `return` what you want back." }
                },
                "required": ["action"]
            },
            "annotations": { "title": "Dev drive", "openWorldHint": false }
        },
        {
            "name": "dev_logs",
            "description": "What the dev instance logged, read from its own log directory. Same \
                            filters as the `logs` tool of a running boite, and both actions read \
                            the files here: the in-memory ring belongs to the window's process, \
                            which is not this one. `tail` is the last few records, `query` is the \
                            same read with the filters applied. Every record is already redacted.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "description": "tail or query. Default query." },
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
            "annotations": { "title": "Dev logs", "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "dev_db",
            "description": "One read against the dev instance's SQLite, opened read-only. SELECT, \
                            PRAGMA and EXPLAIN and nothing else; a batch is refused whole rather \
                            than truncated. Capped at 200 rows, so say LIMIT and ORDER BY when a \
                            table is large. The file is dev.boite.dev's; the release install's is \
                            not reachable from here.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "One statement. `SELECT id, label, status FROM threads LIMIT 20`." }
                },
                "required": ["sql"]
            },
            "annotations": { "title": "Dev database", "readOnlyHint": true, "openWorldHint": false }
        },
        {
            "name": "dev_scenario",
            "description": "The end-to-end suite: the files `e2e/*.e2e.ts`, driven through the five \
                            tools above against a dev window of their own. `list` names them; `run` \
                            spawns `bun run e2e` in the repo, with a name to run one and no name to \
                            run all of them, and answers the vitest summary plus the assertions that \
                            failed rather than the whole log. It waits up to twenty minutes, because \
                            the first scenario waits out a cold debug build, and the whole `bun` \
                            tree is held in a job object stopped by the pid captured at spawn if it \
                            runs past that. The run starts its own window on port 1430, so stop \
                            yours with dev_window action=stop before asking for one.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "description": "list or run. Default list." },
                    "name": { "type": "string", "description": "For run: one scenario, such as chat. Omit for all of them." }
                }
            },
            "annotations": { "title": "Dev scenario", "openWorldHint": false }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_is_named_and_schemad() {
        let tools = dev_tools();
        let list = tools.as_array().expect("array");
        assert_eq!(list.len(), 6);
        for tool in list {
            assert!(tool.get("name").and_then(|v| v.as_str()).is_some());
            assert!(tool.get("description").and_then(|v| v.as_str()).is_some());
            assert_eq!(tool["inputSchema"]["type"], "object");
        }
    }

    /// The names are the contract with `call_dev_tool`, and a typo in either
    /// is a tool that answers "unknown tool" forever.
    #[test]
    fn the_names_are_the_six_the_dispatch_answers() {
        let tools = dev_tools();
        let names: Vec<&str> = tools
            .as_array()
            .expect("array")
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                "dev_window",
                "dev_inspect",
                "dev_drive",
                "dev_logs",
                "dev_db",
                "dev_scenario"
            ]
        );
    }

    /// `eval` reaches the IPC that spawns PTYs. An agent that reads the list
    /// and not the source has to be told that in the list.
    #[test]
    fn eval_says_it_is_dev_only_and_reaches_the_ipc() {
        let tools = dev_tools();
        let drive = tools
            .as_array()
            .expect("array")
            .iter()
            .find(|t| t["name"] == "dev_drive")
            .expect("dev_drive");
        let description = drive["description"].as_str().expect("description");
        assert!(description.contains("dev only"), "{description}");
        assert!(description.contains("IPC"), "{description}");
    }
}
