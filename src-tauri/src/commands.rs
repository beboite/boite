use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeBody, Request},
};

use serde_json::Value;

use boite_core::capability::Grant;
use boite_core::command::{sessions::Own, Command, Files, Git, Sessions};
use boite_core::pty::{PtyManager, PtySpawnArgs};
use boite_core::scope::ProjectRoots;
use boite_core::session;

use crate::BootState;
use crate::local_pty::{LocalSessions, LocalSink};
use crate::logging::{self, LogEntry};

// Wire shape consumed by the webview xterm bridge. Output is base64-encoded
// here (not in core): a Vec<u8> would serialize as a JSON number array,
// ~4x the payload plus an expensive per-chunk parse webview-side.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WirePtyEvent {
    Output { data: String },
    Title { value: String },
    Exit { code: Option<i32> },
    Error { message: String },
}

// Starts the shell's function/alias probe ahead of the first spawn, so the
// decision "does this shortcut need a shell" is already answerable by the time
// the user clicks one. Returns immediately; the probe runs on its own thread.
#[tauri::command]
pub fn pty_warm_shell(manager: State<'_, PtyManager>, shell_id: String) {
    manager.warm_shell_names(&shell_id);
}

// Attach-or-spawn keyed by thread id. Reattaches to a still-alive detached PTY
// (replaying its scrollback ring and resizing to repaint) so local processes
// survive a workspace switch; otherwise spawns a fresh process.
#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    sessions: State<'_, LocalSessions>,
    thread_id: String,
    on_event: Channel<WirePtyEvent>,
    mut spec: PtySpawnArgs,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    let sessions = sessions.inner().clone();
    // Boite spawns the child, so it can hand it credentials no configuration
    // could: a key minted for this thread alone, in a file only this user can
    // read. The agent inside this terminal reaches its own project and nothing
    // else, because that is what its key verifies against. An agent started
    // outside Boite has no key and gets in nowhere.
    //
    // A thread that cannot be given one opens anyway, without Boite tools. The
    // alternative is refusing to open a terminal because its todo list would be
    // missing, which is the wrong thing to lose.
    if let Some(api) = app.try_state::<crate::agent_api::AgentApi>() {
        match crate::agent_api::mint_thread_key(&app, &api, &thread_id) {
            Ok(key_path) => {
                let env = spec.env.get_or_insert_with(Default::default);
                env.insert(boite_agent_api::env::URL.into(), api.url.clone());
                // The path, never the key itself. See `boite_core::secret_file`.
                env.insert(
                    boite_agent_api::env::KEY_FILE.into(),
                    key_path.to_string_lossy().into_owned(),
                );
                env.insert(boite_agent_api::env::THREAD.into(), thread_id.clone());
            }
            Err(e) => crate::logging::warn_to_log(
                &app,
                "agent-api",
                &format!("thread {thread_id} spawns without tools: {e}"),
            ),
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Some((pty_id, sink)) = sessions.get(&thread_id) {
            if manager.is_alive(&pty_id) {
                sink.set_channel(Some(on_event));
                sink.replay();
                let _ = manager.resize(&pty_id, spec.cols, spec.rows);
                return Ok(pty_id);
            }
            sessions.remove_by_pty(&pty_id);
        }
        let sink = Arc::new(LocalSink::new(on_event));
        let pty_id = manager.spawn(sink.clone(), spec)?;
        sessions.insert(thread_id, pty_id.clone(), sink);
        Ok(pty_id)
    })
    .await
    .map_err(|e| format!("pty open task failed: {e}"))?
}

// Detach (do not kill): drop the channel but keep the child + reader alive and
// buffering, so a later pty_open reattaches.
#[tauri::command]
pub fn pty_detach(sessions: State<'_, LocalSessions>, id: String) -> Result<(), String> {
    sessions.detach_by_pty(&id);
    Ok(())
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-pty-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing x-pty-id header".to_string())?;
    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(b) => b.as_slice(),
        InvokeBody::Json(_) => return Err("expected raw body".into()),
    };
    manager.write(id, bytes)
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows)
}

#[tauri::command]
pub async fn pty_kill(
    manager: State<'_, PtyManager>,
    sessions: State<'_, LocalSessions>,
    id: String,
    wait: Option<bool>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let sessions = sessions.inner().clone();
    let wait = wait.unwrap_or(true);
    let pty_id = id.clone();
    let res = tauri::async_runtime::spawn_blocking(move || manager.kill(&id, wait))
        .await
        .map_err(|e| format!("pty kill task failed: {e}"))?;
    sessions.remove_by_pty(&pty_id);
    res
}

#[tauri::command]
pub fn register_project_roots(
    app: tauri::AppHandle,
    state: State<'_, ProjectRoots>,
    mut roots: Vec<String>,
) {
    // In scope for the worktrees the old layout left behind. A thread's worktree
    // now lives under its own project, which is already a root, but one not yet
    // migrated still has to be readable to be moved. Created here because
    // `replace` canonicalizes and silently drops what does not exist yet.
    if let Ok(base) = crate::app_data::worktree_base(&app) {
        if std::fs::create_dir_all(&base).is_ok() {
            roots.push(base.to_string_lossy().to_string());
        }
    }
    state.replace(roots);
}

/// Where a thread with no project of its own runs, and the default parent for
/// a project that has no path yet.
#[tauri::command]
pub fn home_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("no home directory: {e}"))
}

/// What is already sitting at a path a new project wants.
///
/// Unscoped through the registered roots, like `inspect_project`, and for the
/// same reason: it runs before the folder is anyone's root. Both boundaries and
/// both refusals live on the bus now, so this side and the server cannot answer
/// the question differently.
#[tauri::command]
pub async fn folder_state(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::FolderState { path }.into()).await
}

/// Makes the folder a new project will live in.
#[tauri::command]
pub async fn create_project_folder(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::CreateFolder { path }.into()).await
}

/// What a folder says about itself before it is a project: a name, an icon, a
/// remote.
///
/// Deliberately NOT scoped through `ProjectRoots`, unlike every other
/// path-taking command here: inspection is what produces the name and icon a
/// project is created WITH, so it necessarily runs before that project is a
/// registered root. The desktop has no outer boundary to apply — the user's own
/// folder dialog is it — so what the command can reveal is capped in
/// `boite_core::project` instead: `.git/config` remotes, plus an image from a
/// fixed list of subdirectories, image extensions only, 2 MB max. Keep it that
/// way.
#[tauri::command]
pub async fn inspect_project(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::Inspect { path }.into()).await
}

#[tauri::command]
pub async fn read_dir(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Files::ReadDir { path }.into()).await
}

#[tauri::command]
pub async fn explorer_search(
    scope: State<'_, ProjectRoots>,
    path: String,
    query: String,
    limit: u32,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::Search { path, query, limit }.into()).await
}

/// A whole file, base64, for the window to draw.
///
/// PDFs and images: `read_text_file` refuses them at the first NUL byte, and
/// there is nowhere else for the bytes to come from. The size ceiling lives with
/// the reader in `boite_core::editor`; it is a memory ceiling on the window, not
/// a disk limit.
#[tauri::command]
pub async fn read_file_base64(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::ReadBase64 { path }.into()).await
}

#[tauri::command]
pub async fn read_text_file(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::Read { path }.into()).await
}

#[tauri::command]
pub async fn write_text_file(
    scope: State<'_, ProjectRoots>,
    path: String,
    content: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Files::Write { path, content }.into()).await
}

#[tauri::command]
pub async fn default_shell(scope: State<'_, ProjectRoots>) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::ShellDefault.into()).await
}

#[tauri::command]
pub async fn available_shells(
    scope: State<'_, ProjectRoots>,
    refresh: Option<bool>,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Sessions::ShellAvailable {
            refresh: refresh.unwrap_or(false),
        }
        .into(),
    )
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpConfig {
    /// Absolute path to the bundled shim.
    pub sidecar_path: String,
    /// Generated file to hand an agent that takes one at launch.
    pub config_path: String,
}

/// Prepares the MCP server definition agents are pointed at, and returns where
/// it lives.
///
/// A file rather than an inline JSON argument: Boite often launches through a
/// wrap shell, where arguments are re-quoted into a command line. That quoting
/// escapes `"` as `\"`, which POSIX shells accept and PowerShell does not — so
/// a JSON string would break on the platform this app targets first. A path
/// carries neither quotes nor braces and survives every shell.
///
/// Rewritten on every call rather than cached: the sidecar sits next to the
/// running binary, so its path moves with an update or a reinstall, and a stale
/// file would point an agent at a binary that is no longer there.
#[tauri::command]
pub async fn agent_mcp_config(app: AppHandle) -> Result<AgentMcpConfig, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "executable has no parent directory".to_string())?;
    let sidecar = dir.join(if cfg!(windows) {
        "boite-mcp.exe"
    } else {
        "boite-mcp"
    });
    if !sidecar.is_file() {
        // A dev build that never ran `bun run build:sidecar`. Say so plainly:
        // pointing an agent at a missing binary fails later and less clearly.
        return Err(format!("shim not found at {}", sidecar.display()));
    }

    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("create config dir: {e}"))?;
    let config_path = config_dir.join("mcp-boite.json");

    let body = serde_json::json!({
        "mcpServers": {
            "boite": { "command": sidecar.to_string_lossy() }
        }
    });
    std::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&body).map_err(|e| format!("serialize: {e}"))?,
    )
    .map_err(|e| format!("write mcp config: {e}"))?;

    Ok(AgentMcpConfig {
        sidecar_path: sidecar.to_string_lossy().into_owned(),
        config_path: config_path.to_string_lossy().into_owned(),
    })
}

/// Registers the shim with an agent that keeps its MCP servers in a config
/// file, by running that agent's own documented command.
///
/// Running their CLI rather than editing their files: `~/.codex/config.toml`,
/// `opencode.json` and `.cursor/mcp.json` are formats we would have to parse
/// and merge without breaking what is already there, and one of them lives in
/// the user's repository. The agent knows how to write its own config.
#[tauri::command]
pub async fn register_agent_mcp(cli: String, sidecar_path: String) -> Result<String, String> {
    // Allow-listed rather than free-form: this runs a process, and the caller
    // is a webview. Only these three expose an `mcp add` subcommand.
    let cli = match cli.as_str() {
        "codex" | "opencode" | "cursor-agent" => cli,
        other => return Err(format!("no known mcp command for {other}")),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new(&cli)
            .args(["mcp", "add", "boite", "--", &sidecar_path])
            .output()
            .map_err(|e| format!("could not run {cli}: {e}"))?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
        }
        // The agent's own words are more useful than ours: it knows whether the
        // name is taken, the config is unreadable, or the flag has moved on.
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("{cli} exited with {}", out.status)
        } else {
            err
        })
    })
    .await
    .map_err(|e| format!("register task failed: {e}"))?
}

/// Config files where each agent keeps its MCP servers, home-relative first and
/// then project-relative. Only agents Boite cannot wire at launch are listed:
/// claude and codex are handed everything on the command line and keep nothing.
fn agent_config_files(key: &str, home: &Path, cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    match key {
        "copilot" => out.push(home.join(".copilot").join("mcp-config.json")),
        "cursor" => {
            out.push(home.join(".cursor").join("mcp.json"));
            if let Some(cwd) = cwd {
                out.push(cwd.join(".cursor").join("mcp.json"));
            }
        }
        // Shared by the CLI and the IDE. The workspace file is not read here for
        // the same reason it is not offered: upstream reads it and ignores it.
        "antigravity" => out.push(home.join(".gemini").join("config").join("mcp_config.json")),
        "opencode" => {
            let dir = home.join(".config").join("opencode");
            out.push(dir.join("opencode.json"));
            out.push(dir.join("opencode.jsonc"));
            if let Some(cwd) = cwd {
                out.push(cwd.join("opencode.json"));
                out.push(cwd.join("opencode.jsonc"));
            }
        }
        "grok" => {
            out.push(home.join(".grok").join("config.toml"));
            if let Some(cwd) = cwd {
                out.push(cwd.join(".grok").join("config.toml"));
            }
        }
        "hermes" => out.push(home.join(".hermes").join("config.yaml")),
        _ => {}
    }
    out
}

/// Whether an agent can already reach this project's list.
///
/// `"this"` — a boite server is registered. `"none"` — nothing. There is no
/// third state any more: the shim sends the directory it runs in and the
/// endpoint answers for the project that owns it, so an entry made from any
/// project serves every project. What the file names is now only the fallback
/// for a directory no project claims.
///
/// Matched by searching for the path rather than by parsing: the six formats
/// here are JSON, JSONC, TOML and YAML, and the question asked — does this file
/// name that file — does not need a parser for any of them. Windows paths are
/// searched for in their JSON-escaped form too, which is the one difference a
/// JSON document actually makes.
#[tauri::command]
pub fn agent_mcp_registration(
    app: AppHandle,
    key: String,
    project_id: String,
    cwd: Option<String>,
) -> String {
    let Ok(home) = app.path().home_dir() else {
        return "none".into();
    };
    let Ok(creds) = agent_mcp_project_path(app.clone(), project_id) else {
        return "none".into();
    };
    let cwd = cwd.map(PathBuf::from);
    let texts: Vec<String> = agent_config_files(&key, &home, cwd.as_deref())
        .into_iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect();
    registration_in(&texts, &creds).into()
}

/// The reading itself, kept apart from the file system so it can be tested.
fn registration_in(texts: &[String], creds: &str) -> &'static str {
    // Serialized as a JSON string, then unwrapped: this is `\\` for a Windows
    // separator and the untouched path everywhere else.
    let escaped = serde_json::to_string(creds).unwrap_or_default();
    let escaped = escaped.trim_matches('"');

    for text in texts {
        // The credentials path is still worth matching first: it is the one
        // form that proves the entry is Boite's even if the binary was renamed
        // or wrapped.
        if text.contains(creds) || (!escaped.is_empty() && text.contains(escaped)) {
            return "this";
        }
        // Matched on the binary, not on the server name: an entry the user
        // called something else still counts as registered. Which project's
        // file it names no longer decides anything — the directory does.
        if text.contains("boite-mcp") {
            return "this";
        }
    }
    "none"
}

#[cfg(test)]
mod registration_tests {
    use super::registration_in;

    const CREDS: &str = "/Users/x/Library/Application Support/dev.boite.app/mcp/abc.json";

    #[test]
    fn absent_config_is_none() {
        assert_eq!(registration_in(&[], CREDS), "none");
        assert_eq!(
            registration_in(&[r#"{"mcpServers":{"supabase":{}}}"#.to_string()], CREDS),
            "none"
        );
    }

    #[test]
    fn this_projects_credentials_are_recognized() {
        let text = format!(r#"{{"command":"/x/boite-mcp","args":["{CREDS}"]}}"#);
        assert_eq!(registration_in(&[text], CREDS), "this");
    }

    /// An entry made from another project used to be a third state, because the
    /// file it named was the only thing that decided which list was written.
    /// The shim now sends its directory and the endpoint resolves the project
    /// from that, so the same entry reaches this project too.
    #[test]
    fn an_entry_made_from_another_project_still_reaches_this_one() {
        let text = r#"{"command":"/x/boite-mcp","args":["/Users/x/.../mcp/other.json"]}"#;
        assert_eq!(registration_in(&[text.to_string()], CREDS), "this");
    }

    /// A Windows path is stored with escaped separators in a JSON config; the
    /// raw form would never match it.
    #[test]
    fn windows_separators_survive_json_escaping() {
        let creds = r"C:\Users\x\AppData\Roaming\dev.boite.app\mcp\abc.json";
        let text = r#"{"args":["C:\\Users\\x\\AppData\\Roaming\\dev.boite.app\\mcp\\abc.json"]}"#;
        assert_eq!(registration_in(&[text.to_string()], creds), "this");
    }

    /// TOML and YAML keep the path verbatim, which the raw match already covers.
    #[test]
    fn unquoted_formats_match_too() {
        let toml = format!("[mcp_servers.boite]\ncommand = \"/x/boite-mcp\"\nargs = [\"{CREDS}\"]");
        assert_eq!(registration_in(&[toml], CREDS), "this");
    }

    /// One agent, several candidate files: any of them naming the shim answers
    /// for the agent, whichever one it is found in.
    #[test]
    fn a_later_file_can_still_be_this_project() {
        let stale = r#"{"args":["/Users/x/.../mcp/other.json"],"command":"/x/boite-mcp"}"#;
        let good = format!(r#"{{"args":["{CREDS}"]}}"#);
        assert_eq!(registration_in(&[stale.to_string(), good], CREDS), "this");
    }
}

/// Where a project's credentials file lives, for an agent that cannot be handed
/// anything at launch.
///
/// Startup writes one per project it finds, which leaves out every project
/// created since — and those are the ones someone is most likely to be wiring
/// an agent for right now. So a missing file is written rather than reported:
/// the endpoint is already up, and its address is the only thing the file says.
#[tauri::command]
pub fn agent_mcp_project_path(app: AppHandle, project_id: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let path = dir.join("mcp").join(format!("{project_id}.json"));
    if path.is_file() {
        return Ok(path.to_string_lossy().into_owned());
    }
    let api = app
        .try_state::<crate::agent_api::AgentApi>()
        .ok_or("the agent endpoint is not running")?;
    let written = crate::agent_api::write_one(&app, &api, &project_id)?;
    Ok(written.to_string_lossy().into_owned())
}

/// Whether the agent endpoint is up. The panel asks before calling an agent
/// ready: having the binary and knowing how to wire it says nothing about the
/// door being open, and a thread launched before it was answered its agent with
/// no credentials at all.
#[tauri::command]
pub fn agent_api_ready(app: AppHandle) -> bool {
    app.try_state::<crate::agent_api::AgentApi>().is_some()
}

/// Whether copilot still has something to come back to under this id. Threads
/// captured before empty sessions were filtered out carry ids copilot refuses.
#[tauri::command]
pub async fn copilot_session_resumable(
    scope: State<'_, ProjectRoots>,
    session_id: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::CopilotResumable { session_id }.into()).await
}

/// Session ids claude currently has open. `--resume` refuses every one of them,
/// so a thread holding a captured id has to ask before replaying it.
#[tauri::command]
pub async fn live_claude_sessions(scope: State<'_, ProjectRoots>) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::LiveClaude.into()).await
}

/// What the agents behind these threads say they are doing right now.
#[tauri::command]
pub async fn agent_turns(
    scope: State<'_, ProjectRoots>,
    queries: Vec<session::TurnQuery>,
) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::AgentTurns { queries }.into()).await
}

/// Releases a background agent so `--resume` works on that session again.
#[tauri::command]
pub async fn stop_claude_session(
    scope: State<'_, ProjectRoots>,
    session_id: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::StopClaude { session_id }.into()).await
}

/// What the agents spent in these folders, read out of their own transcripts.
#[tauri::command]
pub async fn agent_token_usage(
    scope: State<'_, ProjectRoots>,
    cwds: Vec<String>,
    days: u32,
) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::Usage { cwds, days }.into()).await
}

/// Carries a captured conversation to the folder its agent will look for it in
/// after a thread changed project.
#[tauri::command]
pub async fn migrate_session(
    scope: State<'_, ProjectRoots>,
    kind: String,
    session_id: String,
    from_cwd: String,
    to_cwd: String,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Sessions::Migrate {
            kind,
            session_id,
            from_cwd,
            to_cwd,
        }
        .into(),
    )
    .await
}

/// The session an agent opened in this directory.
///
/// Eight commands, one per agent, each a codec onto the same command. They were
/// eight copies of the same four lines on this side and one `kind` switch on the
/// server; the names stay because the frontend calls them, the behaviour does
/// not because there is only one of it now.
///
/// `pty_id` rather than a pid: the pid is the manager's to know and it changes
/// on every respawn, while the id does not.
macro_rules! session_finder {
    ($name:ident, $kind:literal) => {
        #[tauri::command]
        pub async fn $name(
            scope: State<'_, ProjectRoots>,
            manager: State<'_, PtyManager>,
            cwd: String,
            after_unix_ms: i64,
            exclude_ids: Option<Vec<String>>,
            pty_id: Option<String>,
        ) -> Result<Value, String> {
            on_bus_with_pty(
                scope.inner(),
                manager.inner(),
                Sessions::Find {
                    kind: $kind.into(),
                    cwd,
                    after_unix_ms,
                    exclude_ids: exclude_ids.unwrap_or_default(),
                    own: Own::Pty(pty_id),
                }
                .into(),
            )
            .await
        }
    };
}

session_finder!(find_claude_session, "claude");
session_finder!(find_codex_session, "codex");
session_finder!(find_opencode_session, "opencode");
session_finder!(find_cursor_session, "cursor");
session_finder!(find_antigravity_session, "antigravity");
session_finder!(find_copilot_session, "copilot");
session_finder!(find_grok_session, "grok");
session_finder!(find_hermes_session, "hermes");

/// The desktop's answer to what a command may reach.
///
/// Built per call, and small: the registered roots for anything that takes a
/// path, this app's own PTY manager for the one command that has to tell its
/// own live session from a neighbour's, and the directory an earlier release
/// put worktrees under. Everything else a command needs, it derives from what
/// the caller gave it.
struct DesktopHost<'a> {
    roots: &'a ProjectRoots,
    manager: Option<&'a PtyManager>,
    legacy_worktree_base: Option<PathBuf>,
}

impl<'a> DesktopHost<'a> {
    fn new(roots: &'a ProjectRoots) -> Self {
        Self {
            roots,
            manager: None,
            legacy_worktree_base: None,
        }
    }

    fn with_pty(mut self, manager: &'a PtyManager) -> Self {
        self.manager = Some(manager);
        self
    }

    fn with_legacy_worktree_base(mut self, base: PathBuf) -> Self {
        self.legacy_worktree_base = Some(base);
        self
    }
}

impl boite_core::command::Host for DesktopHost<'_> {
    fn roots(&self) -> &ProjectRoots {
        self.roots
    }

    fn legacy_worktree_base(&self) -> Option<PathBuf> {
        self.legacy_worktree_base.clone()
    }

    fn child_pid(&self, pty_id: &str) -> Option<u32> {
        self.manager.and_then(|m| m.child_pid(pty_id))
    }
}

/// Puts a command through the bus and hands back its answer.
///
/// Every git, worktree, filesystem and session capability on this side is one of
/// these: the trust boundary, the work and the refusals all live in
/// `boite_core::command`, and what is left here is naming the command and
/// handing over the arguments the webview sent. The desktop reads an answer bare
/// — the envelopes in `command::Wire` are the WebSocket protocol's, and `invoke`
/// already carries the shape the frontend types.
async fn through(host: DesktopHost<'_>, command: Command) -> Result<Value, String> {
    // `Local`: this door is the user's own window. An agent never reaches it —
    // it goes through the agent endpoint, which carries its own grant.
    let ready = command.prepare(&host, Grant::Local)?;
    tauri::async_runtime::spawn_blocking(move || ready.run())
        .await
        .map_err(|e| format!("command task failed: {e}"))?
}

/// The common form: a command that needs nothing but the roots.
async fn on_bus(roots: &ProjectRoots, command: Command) -> Result<Value, String> {
    through(DesktopHost::new(roots), command).await
}

/// A session lookup, which needs this app's PTY manager to know which process
/// the caller's own terminal is running.
async fn on_bus_with_pty(
    roots: &ProjectRoots,
    manager: &PtyManager,
    command: Command,
) -> Result<Value, String> {
    through(DesktopHost::new(roots).with_pty(manager), command).await
}

#[tauri::command]
pub async fn git_repo_info(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::RepoInfo { path }.into()).await
}

#[tauri::command]
pub async fn git_find_repos(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::FindRepos { path }.into()).await
}

#[tauri::command]
pub async fn git_branches(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Branches { path }.into()).await
}

#[tauri::command]
pub async fn git_switch_branch(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
    create: bool,
    stash: bool,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Git::SwitchBranch {
            path,
            name,
            create,
            stash,
        }
        .into(),
    )
    .await
}

/// Opens a detached worktree for a thread and hands back its directory, or null
/// when this repository is not one to open a worktree in.
///
/// Traced from end to end, and that is not decoration. A thread waits on this
/// answer before its PTY starts, so an answer that never comes is a black
/// terminal, a reload that does nothing and a thread that cannot be closed —
/// with nothing on screen to say why. Three records tell the three failures
/// apart: no `done` means the work itself is stuck, `done` without the
/// frontend's own line means the reply never crossed back, and a long `done` is
/// simply a large repository being provisioned.
///
/// That is why this one does not go through `on_bus`: the middle record has to
/// be written on the blocking thread, next to the work, rather than after the
/// await where it would say nothing the last record does not.
#[tauri::command]
pub async fn worktree_open(
    app: tauri::AppHandle,
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
) -> Result<Value, String> {
    let traced = thread_id.clone();
    let ready = Command::from(Git::WorktreeOpen { repo, thread_id })
        .prepare(&DesktopHost::new(scope.inner()), Grant::Local)?;
    let handle = app.clone();
    let label = traced.clone();
    let _ = crate::logging::append_app_log(
        &app,
        "info",
        "worktree",
        &format!("{traced}: opening"),
        None,
    );
    let started = std::time::Instant::now();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        let out = ready.run();
        let took = started.elapsed().as_millis();
        let said = match &out {
            Ok(Value::Null) => {
                format!("{label}: done in {took}ms — no worktree for this repository")
            }
            Ok(value) => format!(
                "{label}: done in {took}ms — {}",
                value.as_str().unwrap_or_default()
            ),
            Err(err) => format!("{label}: failed in {took}ms — {err}"),
        };
        let _ = crate::logging::append_app_log(&handle, "info", "worktree", &said, None);
        out
    })
    .await
    .map_err(|e| format!("worktree_open task failed: {e}"))?;
    let _ = crate::logging::append_app_log(
        &app,
        "info",
        "worktree",
        &format!(
            "{traced}: answering after {}ms",
            started.elapsed().as_millis()
        ),
        None,
    );
    answer
}

#[tauri::command]
pub async fn worktree_warm(
    scope: State<'_, ProjectRoots>,
    repo: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeWarm { repo }.into()).await
}

/// Moves a worktree left over from the old layout into its project.
///
/// The legacy base is read here rather than inside the bus because this app is
/// the only thing that knows where its own earlier releases put it, and a data
/// directory it cannot resolve is an error to report rather than a worktree to
/// leave alone.
#[tauri::command]
pub async fn worktree_migrate(
    app: tauri::AppHandle,
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
    from: String,
) -> Result<Value, String> {
    let legacy = crate::app_data::worktree_base(&app)?;
    through(
        DesktopHost::new(scope.inner()).with_legacy_worktree_base(legacy),
        Git::WorktreeMigrate {
            repo,
            thread_id,
            from,
        }
        .into(),
    )
    .await
}

#[tauri::command]
pub async fn worktree_adopt(
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeAdopt { repo, thread_id }.into()).await
}

#[tauri::command]
pub async fn worktree_list(
    scope: State<'_, ProjectRoots>,
    repo: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeList { repo }.into()).await
}

#[tauri::command]
pub async fn worktree_claim(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeClaim { path, name }.into()).await
}

#[tauri::command]
pub async fn worktree_reserve(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeReserve { path, name }.into()).await
}

#[tauri::command]
pub async fn worktree_hold(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeHold { path }.into()).await
}

#[tauri::command]
pub async fn worktree_remove(
    scope: State<'_, ProjectRoots>,
    repo: String,
    path: String,
    force: bool,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::WorktreeRemove { repo, path, force }.into()).await
}

#[tauri::command]
pub async fn git_status(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Status { path }.into()).await
}

#[tauri::command]
pub async fn git_changed_paths(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::ChangedPaths { path }.into()).await
}

#[tauri::command]
pub async fn git_commit_state(
    scope: State<'_, ProjectRoots>,
    path: String,
    sha: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::CommitState { path, sha }.into()).await
}

#[tauri::command]
pub async fn git_pull_request(
    scope: State<'_, ProjectRoots>,
    path: String,
    branch: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::PullRequest { path, branch }.into()).await
}

#[tauri::command]
pub async fn git_log(
    scope: State<'_, ProjectRoots>,
    path: String,
    limit: u32,
    skip: u32,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Log { path, limit, skip }.into()).await
}

#[tauri::command]
pub async fn git_stage(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Stage { path, files }.into()).await
}

#[tauri::command]
pub async fn git_unstage(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Unstage { path, files }.into()).await
}

#[tauri::command]
pub async fn git_discard(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
    untracked: Vec<String>,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Git::Discard {
            path,
            files,
            untracked,
        }
        .into(),
    )
    .await
}

#[tauri::command]
pub async fn git_commit(
    scope: State<'_, ProjectRoots>,
    path: String,
    message: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Commit { path, message }.into()).await
}

#[tauri::command]
pub async fn git_fetch(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Fetch { path }.into()).await
}

#[tauri::command]
pub async fn git_push(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Push { path }.into()).await
}

#[tauri::command]
pub async fn git_pull(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Pull { path }.into()).await
}

#[tauri::command]
pub async fn git_init(scope: State<'_, ProjectRoots>, path: String) -> Result<Value, String> {
    on_bus(scope.inner(), Git::Init { path }.into()).await
}

#[tauri::command]
pub async fn git_file_versions(
    scope: State<'_, ProjectRoots>,
    path: String,
    file: String,
    head_file: Option<String>,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Git::FileVersions {
            path,
            file,
            head_file,
        }
        .into(),
    )
    .await
}

/// Everything at once, for whoever has to work out why something is wrong.
///
/// Assembled in `boite_core::snapshot` so this side and the server answer the
/// same question the same way. What is added here is this app's own view of
/// which PTYs still have a process, which is the half a database row cannot
/// know.
///
/// Its own connection to the database rather than the endpoint's: a diagnostic
/// call runs rarely, and a snapshot that fails because something else holds a
/// handle would be the second thing that does not work.
#[tauri::command]
pub async fn workspace_snapshot(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    sessions: State<'_, LocalSessions>,
    scope: State<'_, ProjectRoots>,
) -> Result<Value, String> {
    let live: Vec<boite_core::snapshot::LivePty> = sessions
        .all()
        .into_iter()
        .map(|(thread_id, pty_id)| boite_core::snapshot::LivePty {
            child_pid: manager.child_pid(&pty_id),
            thread_id,
            pty_id,
        })
        .collect();
    let db = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?
        .join("boite.db");
    let roots = scope.inner().registered();
    let taken = tauri::async_runtime::spawn_blocking(move || {
        let store = boite_core::store::Store::attach(&db)?;
        let scope = ProjectRoots::default();
        scope.replace(roots);
        Ok::<_, String>(serde_json::to_value(boite_core::snapshot::take(
            "desktop", &store, &scope, live,
        )))
    })
    .await
    .map_err(|e| format!("workspace_snapshot task failed: {e}"))??;
    taken.map_err(|e| format!("snapshot could not be serialised: {e}"))
}

#[tauri::command]
pub fn finish_boot(app: AppHandle, boot: State<'_, BootState>) {
    if !boot.mark_completed() {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        // First paint of the row the client area does not reach; the window
        // event hook keeps it painted from here on.
        crate::paint_frame_gap(&win);
    }
}

#[tauri::command]
pub fn log_app_event(
    app: AppHandle,
    level: String,
    source: String,
    message: String,
    details: Option<String>,
) -> Result<(), String> {
    logging::append_app_log(&app, &level, &source, &message, details.as_deref())
}

#[tauri::command]
pub fn read_app_log(app: AppHandle, scope: String) -> Result<Vec<LogEntry>, String> {
    let path = match scope.as_str() {
        "previous" => logging::previous_log_file_path(&app)?,
        _ => logging::log_file_path(&app)?,
    };
    logging::read_log_file(&path)
}

#[tauri::command]
pub fn clear_app_log(app: AppHandle) -> Result<(), String> {
    logging::clear_log(&app)
}

#[tauri::command]
pub fn log_file_path(app: AppHandle) -> Result<String, String> {
    let path = logging::log_file_path(&app)?;
    Ok(path.to_string_lossy().to_string())
}

// Spawning `where.exe` to answer this popped a console window on Windows, and
// the hand-rolled PATH walk behind it had its own PATHEXT list. `which` is
// already a dependency and already correct on both.
#[tauri::command]
pub async fn command_exists(
    scope: State<'_, ProjectRoots>,
    cmd: String,
) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::CommandExists { cmd }.into()).await
}

// Returns fastpick's JSON verbatim rather than a parsed shape: its schema is
// fastpick's to grow, and the frontend types only the fields it reads.
#[tauri::command]
pub async fn fastpick_list(
    scope: State<'_, ProjectRoots>,
    provider: Option<String>,
    refresh: Option<bool>,
) -> Result<Value, String> {
    on_bus(
        scope.inner(),
        Sessions::FastpickList {
            provider,
            refresh: refresh.unwrap_or(false),
        }
        .into(),
    )
    .await
}

// Null means fastpick is not on this machine, which the settings panel reads as
// "offer the install" rather than as a failure.
#[tauri::command]
pub async fn fastpick_version(scope: State<'_, ProjectRoots>) -> Result<Value, String> {
    on_bus(scope.inner(), Sessions::FastpickVersion.into()).await
}
