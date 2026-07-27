use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeBody, Request},
};

use boite_core::editor::TextFile;
use boite_core::explorer::{DirEntry, SearchHit};
use boite_core::git::{ChangeEntry, Commit, FileVersions, PathStatus, RepoInfo};
use boite_core::project::ProjectInspection;
use boite_core::pty::{EventSink, PtyEvent, PtyManager, PtySpawnArgs};
use boite_core::scope::ProjectRoots;
use boite_core::session::{ClaudeSessionHit, CodexSessionHit};
use boite_core::shell::ShellOption;
use boite_core::{editor, explorer, git, project, session, shell};

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

// Adapts the core EventSink onto a Tauri IPC channel.
struct ChannelSink {
    channel: Channel<WirePtyEvent>,
}

impl EventSink for ChannelSink {
    fn send(&self, event: PtyEvent) -> bool {
        let wire = match event {
            PtyEvent::Output(bytes) => WirePtyEvent::Output {
                data: BASE64.encode(&bytes),
            },
            PtyEvent::Title(value) => WirePtyEvent::Title { value },
            PtyEvent::Exit(code) => WirePtyEvent::Exit { code },
            PtyEvent::Error(message) => WirePtyEvent::Error { message },
        };
        self.channel.send(wire).is_ok()
    }
}

#[tauri::command]
pub async fn pty_spawn(
    manager: State<'_, PtyManager>,
    on_event: Channel<WirePtyEvent>,
    spec: PtySpawnArgs,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    let sink: Arc<dyn EventSink> = Arc::new(ChannelSink { channel: on_event });
    tauri::async_runtime::spawn_blocking(move || manager.spawn(sink, spec))
        .await
        .map_err(|e| format!("pty spawn task failed: {e}"))?
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

async fn run_lookup<F>(f: F) -> Option<String>
where
    F: FnOnce() -> Option<String> + Send + 'static,
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

/// Whether an agent already points at this project's list.
///
/// `"this"` — registered, for this project. `"other"` — registered, but against
/// another project's credentials file: the entry is global while the file is per
/// project, so a registration made from project A keeps writing into A's list
/// from anywhere. `"none"` — nothing.
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

    let mut seen_shim = false;
    for text in texts {
        if text.contains(creds) || (!escaped.is_empty() && text.contains(escaped)) {
            return "this";
        }
        // Matched on the binary, not on the server name: an entry the user
        // called something else still counts as registered.
        if text.contains("boite-mcp") {
            seen_shim = true;
        }
    }
    if seen_shim { "other" } else { "none" }
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

    /// The whole reason the state exists: one entry per agent, one credentials
    /// file per project, so a registration made elsewhere writes elsewhere.
    #[test]
    fn another_projects_credentials_are_not_this_one() {
        let text = r#"{"command":"/x/boite-mcp","args":["/Users/x/.../mcp/other.json"]}"#;
        assert_eq!(registration_in(&[text.to_string()], CREDS), "other");
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

    /// One agent, several candidate files: the answer is the best of them, not
    /// the first one read.
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

#[tauri::command]
pub async fn find_claude_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<ClaudeSessionHit> {
    let exclude = session::build_exclude(exclude_ids);
    tauri::async_runtime::spawn_blocking(move || {
        session::find_claude_session_blocking(cwd, after_unix_ms, &exclude)
    })
    .await
    .ok()
    .flatten()
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
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_opencode_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_cursor_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_cursor_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_antigravity_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_antigravity_session_blocking(cwd, after_unix_ms, &exclude))
        .await
}

#[tauri::command]
pub async fn find_copilot_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_copilot_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_grok_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
    let exclude = session::build_exclude(exclude_ids);
    run_lookup(move || session::find_grok_session_blocking(cwd, after_unix_ms, &exclude)).await
}

#[tauri::command]
pub async fn find_hermes_session(
    cwd: String,
    after_unix_ms: i64,
    exclude_ids: Option<Vec<String>>,
) -> Option<String> {
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

/// Opens a detached worktree for a thread and hands back its directory.
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
) -> Result<String, String> {
    scope.ensure_allowed(&repo)?;
    let base = crate::app_data::worktree_base(&app)?;
    std::fs::create_dir_all(&base).map_err(|e| format!("worktree base: {e}"))?;
    let path = git::worktree_path_for(&base, &thread_id);
    let path = path.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || git::add_detached_worktree_blocking(&repo, &path))
        .await
        .map_err(|e| format!("worktree_open task failed: {e}"))?
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

