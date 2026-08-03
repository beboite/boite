//! A terminal this app owns.
//!
//! The one surface that is not a codec over the command bus, and the reason
//! there is a `bus` module rather than a single file: a PTY is a live process
//! with a channel to the webview, a scrollback ring and a detach that has to
//! keep the child alive. None of that is a command with an answer.

use std::sync::Arc;

use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeBody, Request},
};


use boite_core::pty::{PtyManager, PtySpawnArgs};

use crate::local_pty::{LocalSessions, LocalSink};


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
    // Beside the database, so a terminal's whole run outlives the process that
    // printed it. `None` only when the app has no config directory, which is
    // the same condition that leaves it with no database either.
    let transcripts = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("transcripts"));

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
        let sink = Arc::new(match &transcripts {
            Some(dir) => LocalSink::recording(on_event, dir, &thread_id),
            None => LocalSink::new(on_event),
        });
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
