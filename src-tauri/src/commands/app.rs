//! What only this process can answer for.
//!
//! Its own log file, its own boot sequence, the whole-workspace snapshot, and
//! the two questions about this machine that are not about a project: whether a
//! command exists, and what fastpick has to offer.


use tauri::{
    AppHandle, Manager, State,
};

use serde_json::Value;

use boite_core::command::Sessions;
use boite_core::pty::PtyManager;
use boite_core::scope::ProjectRoots;

use crate::BootState;
use crate::local_pty::LocalSessions;
use crate::logging::{self, LogEntry};

use super::bus::on_bus;

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

/// What happened here, newest first, with this app's own log merged in.
///
/// The one place the whole timeline can actually be assembled. The database
/// knows what agents did and what moved; the log file knows what the Rust side
/// and the window threw, and it is a file only a desktop has. The server
/// answers `timeline.read` without this half, because on that side the Rust log
/// is stdout and belongs to whatever is running the container.
#[tauri::command]
pub fn workspace_timeline(
    app: AppHandle,
    project: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<boite_core::timeline::Moment>, String> {
    use boite_core::timeline::Moment;

    let limit = limit.unwrap_or(40).clamp(1, 200) as usize;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let store = boite_core::store::Store::attach(&config_dir.join("boite.db"))?;
    let rows = store.timeline(project.as_deref().filter(|p| !p.is_empty()), limit);

    // Only what went wrong. A log line per IPC call would bury the three
    // sources that are actually about the workspace, and an `info` about a
    // successful command is not a moment anybody is looking for.
    let logged: Vec<Moment> = logging::log_file_path(&app)
        .and_then(|path| logging::read_log_file(&path))
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.level == "error" || e.level == "warn")
        .map(|e| Moment {
            at: e.ts_ms as i64,
            kind: format!("log.{}", e.level),
            project_id: String::new(),
            text: format!("{}: {}", e.source, e.message),
        })
        .collect();

    Ok(boite_core::timeline::merge(vec![rows, logged], limit))
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
