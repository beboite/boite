use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeBody, Request},
};

use boite_core::editor::TextFile;
use boite_core::explorer::{DirEntry, SearchHit};
use boite_core::git::{ChangeEntry, Commit, FileVersions, PathStatus, RepoInfo};
use boite_core::project::ProjectInspection;
use boite_core::pty::{PtyManager, PtySpawnArgs};
use boite_core::scope::ProjectRoots;
use boite_core::session::{ClaudeSessionHit, CodexSessionHit};
use boite_core::shell::ShellOption;
use boite_core::{editor, explorer, git, project, session, shell, usage};

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
    // could: the agent inside this terminal reaches its own todo list and
    // nothing else, because the thread id it presents is the one stamped here.
    // An agent started outside Boite simply has no token.
    if let Some(api) = app.try_state::<crate::agent_api::AgentApi>() {
        let env = spec.env.get_or_insert_with(Default::default);
        env.insert("BOITE_MCP_URL".into(), api.url.clone());
        env.insert("BOITE_TOKEN".into(), api.token.clone());
        env.insert("BOITE_THREAD_ID".into(), thread_id.clone());
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
    // Always in scope, and the only worktree path that ever is. Every thread
    // worktree lives under it, so nothing read back from the database can widen
    // the boundary by naming a directory of its own. Created here because
    // `replace` canonicalizes and silently drops what does not exist yet.
    if let Ok(base) = crate::app_data::worktree_base(&app) {
        if std::fs::create_dir_all(&base).is_ok() {
            roots.push(base.to_string_lossy().to_string());
        }
    }
    state.replace(roots);
}

// Deliberately NOT scoped through ProjectRoots, unlike every other path-taking
// command here: inspection is what produces the name/icon a project is created
// WITH, so it necessarily runs before that project is a registered root. The
// server twin (rpc.rs "project.inspect") can gate on BOITE_WORKSPACE_DIR; the
// desktop has no equivalent outer boundary, the user's own folder dialog is it.
// What the command can reveal is therefore capped in boite-core::project:
// `.git/config` remotes, plus an image from a fixed list of subdirectories,
// image extensions only, 2 MB max. Keep it that way.
#[tauri::command]
pub async fn inspect_project(path: String) -> Result<ProjectInspection, String> {
    tauri::async_runtime::spawn_blocking(move || project::inspect_project_blocking(path))
        .await
        .map_err(|e| format!("inspect_project task failed: {e}"))?
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

/// What is already sitting at a path a new project wants. Unscoped like
/// `inspect_project` and for the same reason — it runs before the folder is
/// anyone's root — and it reveals strictly less: three words, no listing.
#[tauri::command]
pub fn folder_state(path: String) -> project::FolderState {
    project::folder_state_blocking(&path)
}

/// Makes the folder a new project will live in.
///
/// The one command here that creates a directory outside every registered root,
/// which it has to: a project's folder is not a root until the project exists.
/// The boundary instead is *where*: under the user's home, or beside a project
/// they already have. An agent can reach this through the MCP endpoint, so a
/// free-form `create_dir_all` was never an option.
#[tauri::command]
pub fn create_project_folder(
    app: AppHandle,
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<(), String> {
    let mut allowed: Vec<String> = scope
        .snapshot()
        .iter()
        .filter_map(|root| {
            std::path::Path::new(root)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
        })
        .collect();
    if let Ok(home) = app.path().home_dir() {
        allowed.push(home.to_string_lossy().to_string());
    }
    if !project::may_create_project_at(&path, &allowed) {
        return Err(
            "a new project has to go under your home folder or beside a project you already have"
                .into(),
        );
    }
    if project::folder_state_blocking(&path) == project::FolderState::Occupied {
        return Err("there is already something in that folder".into());
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("cannot create the folder: {e}"))
}

#[tauri::command]
pub async fn read_dir(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || explorer::read_dir_blocking(path))
        .await
        .map_err(|e| format!("read_dir task failed: {e}"))?
}

#[tauri::command]
pub async fn explorer_search(
    scope: State<'_, ProjectRoots>,
    path: String,
    query: String,
    limit: u32,
) -> Result<Vec<SearchHit>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || explorer::search_blocking(&path, &query, limit))
        .await
        .map_err(|e| format!("explorer_search task failed: {e}"))?
}

#[tauri::command]
pub async fn read_text_file(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<TextFile, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || editor::read_blocking(&path))
        .await
        .map_err(|e| format!("read_text_file task failed: {e}"))?
}

#[tauri::command]
pub async fn write_text_file(
    scope: State<'_, ProjectRoots>,
    path: String,
    content: String,
) -> Result<u64, String> {
    scope.ensure_allowed_for_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || editor::write_blocking(&path, &content))
        .await
        .map_err(|e| format!("write_text_file task failed: {e}"))?
}

#[tauri::command]
pub async fn default_shell() -> String {
    tauri::async_runtime::spawn_blocking(shell::default_shell_blocking)
        .await
        .unwrap_or_else(|_| shell::fallback_shell())
}

#[tauri::command]
pub async fn available_shells() -> Vec<ShellOption> {
    tauri::async_runtime::spawn_blocking(shell::available_shells_blocking)
        .await
        .unwrap_or_default()
}

async fn run_lookup<F, T>(f: F) -> Option<T>
where
    F: FnOnce() -> Option<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.ok().flatten()
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
    let written = crate::agent_api::write_one(&app, &api.url, &api.token, &project_id)?;
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
pub async fn copilot_session_resumable(session_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || session::copilot_session_resumable(&session_id))
        .await
        .unwrap_or(true)
}

/// Session ids claude currently has open. `--resume` refuses every one of
/// them, so a thread holding a captured id has to ask before replaying it.
#[tauri::command]
pub async fn live_claude_sessions() -> Vec<session::LiveClaudeSession> {
    tauri::async_runtime::spawn_blocking(session::live_claude_sessions)
        .await
        .unwrap_or_default()
}

/// Releases a background agent so `--resume` works on that session again.
/// Refuses anything that is not a background agent: an interactive entry is
/// another terminal's open session.
#[tauri::command]
pub async fn stop_claude_session(session_id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || session::stop_claude_session(&session_id))
        .await
        .unwrap_or(false)
}

/// What the agents spent in these folders, read out of their own transcripts.
///
/// The directories come from the caller because a project's threads no longer
/// all run inside it: since worktree isolation most of them run in a detached
/// checkout elsewhere, and every store keys on the directory the agent ran in.
#[tauri::command]
pub async fn agent_token_usage(cwds: Vec<String>, days: u32) -> usage::UsageReport {
    tauri::async_runtime::spawn_blocking(move || usage::collect_usage_blocking(cwds, days))
        .await
        .unwrap_or_default()
}

/// Carries a thread's transcript to the folder it is moving to.
///
/// Claude files its sessions under the directory they ran in, so a thread that
/// changes project changes where `--resume` looks. Answers `false` when there
/// was nothing to carry — a CLI that does not file by directory, or a thread
/// that never wrote a transcript here — which is not a failure and must not
/// stop the move.
#[tauri::command]
pub async fn migrate_session(
    kind: String,
    session_id: String,
    from_cwd: String,
    to_cwd: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session::migrate_session_blocking(&kind, &session_id, &from_cwd, &to_cwd)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn find_claude_session(
    manager: State<'_, PtyManager>,
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
    pty_id: Option<String>,
) -> Result<Option<ClaudeSessionHit>, String> {
    let exclude = session::build_exclude(exclude_ids);
    // Resolved here rather than passed in: the pid is the manager's to know,
    // and it changes on every respawn while the pty id does not.
    let own_pid = pty_id.and_then(|id| manager.child_pid(&id));
    // A Result only because borrowing State from an async command demands one;
    // a detector failure is still "no hit", never an error the caller handles.
    Ok(tauri::async_runtime::spawn_blocking(move || {
        session::find_claude_session_blocking(cwd, after_unix_ms, &exclude, own_pid)
    })
    .await
    .ok()
    .flatten())
}

#[tauri::command]
pub async fn find_codex_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<CodexSessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    tauri::async_runtime::spawn_blocking(move || {
        session::find_codex_session_blocking(cwd, after_unix_ms, &exclude)
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn find_opencode_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<session::SessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_opencode_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_cursor_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<session::SessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_cursor_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_antigravity_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<session::SessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_antigravity_session_blocking(cwd, after_unix_ms, &exclude))
        .await
}

#[tauri::command]
pub async fn find_copilot_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<session::SessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_copilot_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_grok_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<session::SessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_grok_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_hermes_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<session::SessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_hermes_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn git_repo_info(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<RepoInfo, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::repo_info_blocking(&path))
        .await
        .map_err(|e| format!("git_repo_info task failed: {e}"))?
}

#[tauri::command]
pub async fn git_find_repos(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Vec<String>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::find_repos_blocking(&path, 3))
        .await
        .map_err(|e| format!("git_find_repos task failed: {e}"))?
}

#[tauri::command]
pub async fn git_branches(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Vec<git::BranchInfo>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::branches_blocking(&path))
        .await
        .map_err(|e| format!("git_branches task failed: {e}"))?
}

#[tauri::command]
pub async fn git_switch_branch(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
    create: bool,
    stash: bool,
) -> Result<git::BranchChangeResult, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::switch_branch_blocking(&path, &name, create, stash)
    })
    .await
    .map_err(|e| format!("git_switch_branch task failed: {e}"))?
}

/// Opens a detached worktree for a thread and hands back its directory, or
/// `None` when this repository is not one to open a worktree in.
///
/// The base lives beside the database, not inside the project: it is one
/// registered root for every worktree, so a stored path can never widen the
/// filesystem boundary on its own.
#[tauri::command]
pub async fn worktree_open(
    app: tauri::AppHandle,
    scope: State<'_, ProjectRoots>,
    repo: String,
    thread_id: String,
) -> Result<Option<String>, String> {
    scope.ensure_allowed(&repo)?;
    let base = crate::app_data::worktree_base(&app)?;
    std::fs::create_dir_all(&base).map_err(|e| format!("worktree base: {e}"))?;
    let path = git::scoped_dir_for(&base, &thread_id);
    let path = path.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        git::open_worktree_if_eligible_blocking(&repo, &path)
    })
    .await
    .map_err(|e| format!("worktree_open task failed: {e}"))?
}

/// Every worktree of a repository, read from the repository itself.
///
/// Scoped on the repo alone: the paths come back from git rather than going in,
/// so there is nothing here for a caller to point somewhere it should not.
#[tauri::command]
pub async fn worktree_list(
    scope: State<'_, ProjectRoots>,
    repo: String,
) -> Result<Vec<git::WorktreeEntry>, String> {
    scope.ensure_allowed(&repo)?;
    tauri::async_runtime::spawn_blocking(move || git::list_worktrees_blocking(&repo))
        .await
        .map_err(|e| format!("worktree_list task failed: {e}"))?
}

#[tauri::command]
pub async fn worktree_claim(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::claim_worktree_branch_blocking(&path, &name))
        .await
        .map_err(|e| format!("worktree_claim task failed: {e}"))?
}

#[tauri::command]
pub async fn worktree_reserve(
    scope: State<'_, ProjectRoots>,
    path: String,
    name: String,
) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::reserve_worktree_branch_blocking(&path, &name)
    })
    .await
    .map_err(|e| format!("worktree_reserve task failed: {e}"))?
}

#[tauri::command]
pub async fn worktree_hold(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<git::WorktreeHold, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::worktree_hold_blocking(&path))
        .await
        .map_err(|e| format!("worktree_hold task failed: {e}"))?
}

#[tauri::command]
pub async fn worktree_remove(
    scope: State<'_, ProjectRoots>,
    repo: String,
    path: String,
    force: bool,
) -> Result<(), String> {
    scope.ensure_allowed(&repo)?;
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::remove_worktree_blocking(&repo, &path, force)
    })
    .await
    .map_err(|e| format!("worktree_remove task failed: {e}"))?
}

#[tauri::command]
pub async fn git_status(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Vec<ChangeEntry>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::status_blocking(&path))
        .await
        .map_err(|e| format!("git_status task failed: {e}"))?
}

#[tauri::command]
pub async fn git_changed_paths(
    scope: State<'_, ProjectRoots>,
    path: String,
) -> Result<Vec<PathStatus>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::changed_paths_blocking(&path))
        .await
        .map_err(|e| format!("git_changed_paths task failed: {e}"))?
}

/// What the repository says about a commit an agent claimed. Scoped like every
/// other git command: a sha is not a path, but the repository it is read in is.
#[tauri::command]
pub async fn git_commit_state(
    scope: State<'_, ProjectRoots>,
    path: String,
    sha: String,
) -> Result<git::CommitState, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::commit_state_blocking(&path, &sha))
        .await
        .map_err(|e| format!("git_commit_state task failed: {e}"))
}

/// What `gh` says about a branch: a pull request, none, nothing it can answer,
/// or a refusal worth passing on.
#[tauri::command]
pub async fn git_pull_request(
    scope: State<'_, ProjectRoots>,
    path: String,
    branch: String,
) -> Result<git::PrLookup, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::pull_request_for_branch_blocking(&path, &branch)
    })
    .await
    .map_err(|e| format!("git_pull_request task failed: {e}"))
}

#[tauri::command]
pub async fn git_log(
    scope: State<'_, ProjectRoots>,
    path: String,
    limit: u32,
    skip: u32,
) -> Result<Vec<Commit>, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::log_blocking(&path, limit, skip))
        .await
        .map_err(|e| format!("git_log task failed: {e}"))?
}

#[tauri::command]
pub async fn git_stage(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::run_files(&path, "add", &files, true))
        .await
        .map_err(|e| format!("git_stage task failed: {e}"))?
}

#[tauri::command]
pub async fn git_unstage(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::unstage_blocking(&path, files))
        .await
        .map_err(|e| format!("git_unstage task failed: {e}"))?
}

#[tauri::command]
pub async fn git_discard(
    scope: State<'_, ProjectRoots>,
    path: String,
    files: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::discard_blocking(&path, files, untracked))
        .await
        .map_err(|e| format!("git_discard task failed: {e}"))?
}

#[tauri::command]
pub async fn git_commit(
    scope: State<'_, ProjectRoots>,
    path: String,
    message: String,
) -> Result<String, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::commit_blocking(&path, &message))
        .await
        .map_err(|e| format!("git_commit task failed: {e}"))?
}

#[tauri::command]
pub async fn git_fetch(scope: State<'_, ProjectRoots>, path: String) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::fetch_blocking(&path))
        .await
        .map_err(|e| format!("git_fetch task failed: {e}"))?
}

#[tauri::command]
pub async fn git_push(scope: State<'_, ProjectRoots>, path: String) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::push_blocking(&path))
        .await
        .map_err(|e| format!("git_push task failed: {e}"))?
}

#[tauri::command]
pub async fn git_pull(scope: State<'_, ProjectRoots>, path: String) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::pull_blocking(&path))
        .await
        .map_err(|e| format!("git_pull task failed: {e}"))?
}

#[tauri::command]
pub async fn git_init(scope: State<'_, ProjectRoots>, path: String) -> Result<(), String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || git::init_blocking(&path))
        .await
        .map_err(|e| format!("git_init task failed: {e}"))?
}

#[tauri::command]
pub async fn git_file_versions(
    scope: State<'_, ProjectRoots>,
    path: String,
    file: String,
    head_file: Option<String>,
) -> Result<FileVersions, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::file_versions_blocking(&path, &file, head_file.as_deref())
    })
    .await
    .map_err(|e| format!("git_file_versions task failed: {e}"))?
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
pub async fn command_exists(cmd: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || shell::command_exists(&cmd))
        .await
        .unwrap_or(false)
}

// Returns fastpick's JSON verbatim rather than a parsed shape: its schema is fastpick's to
// grow, and the frontend types only the fields it reads.
#[tauri::command]
pub async fn fastpick_list(
    provider: Option<String>,
    refresh: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        boite_core::fastpick::list_blocking(provider, refresh.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Null means fastpick is not on this machine, which the settings panel reads as "offer the
// install" rather than as a failure.
#[tauri::command]
pub async fn fastpick_version() -> Option<String> {
    tauri::async_runtime::spawn_blocking(boite_core::fastpick::version_blocking)
        .await
        .unwrap_or(None)
}

