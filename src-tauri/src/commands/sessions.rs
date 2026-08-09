//! What the agents left on disk, asked for by the window.
//!
//! Codecs over `boite_core::command::Sessions`. The eight `session_finder!`
//! commands are one macro because they are one command with a `kind`: the
//! desktop used to carry eight copies of the same four lines, one per agent,
//! and the server had always had the single version.


use tauri::{AppHandle, State};

use serde_json::Value;

use boite_core::command::{sessions::Own, Sessions};
use boite_core::pty::PtyManager;
use boite_core::scope::ProjectRoots;
use boite_core::session;


use super::bus::{on_bus, on_bus_with_pty, through, DesktopHost};

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

/// What a terminal printed, read back from its transcript.
///
/// The panel behind an agent that stopped talking, and the one thing an agent
/// asked to work out what went wrong could never reach: a PTY's output used to
/// die with the process.
#[tauri::command]
pub async fn thread_transcript(
    app: AppHandle,
    scope: State<'_, ProjectRoots>,
    thread_id: String,
    bytes: u32,
) -> Result<Value, String> {
    through(
        DesktopHost::new(scope.inner()).with_transcripts(&app),
        Sessions::Transcript {
            thread_id,
            bytes,
            dir: None,
        }
        .into(),
    )
    .await
}

/// The session an agent opened in this directory.
///
/// Nine commands, one per agent, each a codec onto the same command. They were
/// nine copies of the same four lines on this side and one `kind` switch on the
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
session_finder!(find_pi_session, "pi");
