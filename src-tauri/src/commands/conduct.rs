//! The orchestration surface, on the desktop's door.
//!
//! Thin like `commands::records`, and behind the same shared store. What the
//! window reaches here is the write half — a worker's phase transitions
//! landing on the pulse, the chat rows, arming an orchestrator — never the
//! long-poll: a webview has Tauri events to wake on and passes `timeoutMs: 0`.
//! The waiter registry is still wired, because the *agent endpoint's*
//! `GET /v1/pulse` holds real waits in this same process, and a write from the
//! window has to wake them.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use boite_core::command::Conduct;
use boite_core::pulse::Waiters;
use boite_core::scope::ProjectRoots;

use super::bus::{through, DesktopHost};
use super::records::Rows;

/// The one wait registry of this app, held by Tauri.
pub struct PulseWaiters(pub Arc<Waiters>);

impl Default for PulseWaiters {
    fn default() -> Self {
        PulseWaiters(Waiters::new())
    }
}

fn decode(method: &str, params: Value) -> Result<Conduct, String> {
    match boite_core::command::Command::decode(method, &params)? {
        boite_core::command::Command::Conduct(c) => Ok(c),
        other => Err(format!("{} is not a conduct command", other.name())),
    }
}

macro_rules! conduct_command {
    ($name:ident, $method:literal) => {
        #[tauri::command]
        pub async fn $name(
            app: AppHandle,
            scope: State<'_, ProjectRoots>,
            rows: State<'_, Rows>,
            waiters: State<'_, PulseWaiters>,
            params: Option<Value>,
        ) -> Result<Value, String> {
            let command = decode($method, params.unwrap_or_else(|| json!({})))?;
            let store = rows.get(&app)?;
            through(
                DesktopHost::new(scope.inner())
                    .with_store(store)
                    .with_pulse(waiters.0.clone()),
                command.into(),
            )
            .await
        }
    };
}

conduct_command!(conduct_pulse, "conduct.pulse");
conduct_command!(conduct_record, "conduct.record");
conduct_command!(conduct_orchestrator_post, "orchestrator.post");
conduct_command!(conduct_orchestrator_say, "orchestrator.say");
conduct_command!(conduct_orchestrator_messages, "orchestrator.messages");
conduct_command!(conduct_orchestrator_start, "orchestrator.start");
conduct_command!(conduct_orchestrator_status, "orchestrator.status");
// The undo list and the undo itself. Both land here because the window is the
// user: the bus refuses `orchestrator.undo` to any agent grant.
conduct_command!(conduct_orchestrator_actions, "orchestrator.actions");
conduct_command!(conduct_orchestrator_undo, "orchestrator.undo");
// The queue's device half. The window is the device on the desktop: it owns
// the PTYs, so it drains, types and settles — the bus refuses these three to
// any agent grant.
conduct_command!(conduct_thread_accept_dispatch, "thread.acceptDispatch");
conduct_command!(conduct_dispatch_drain, "dispatch.drain");
conduct_command!(conduct_dispatch_settle, "dispatch.settle");
// Present for symmetry: the desktop webview usually hears through its own
// SpeechRecognition, but the local engine is a setting, not a platform.
conduct_command!(conduct_voice_transcribe, "voice.transcribe");
