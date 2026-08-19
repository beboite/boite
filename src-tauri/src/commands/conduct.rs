//! The orchestration surface, on the desktop's door.
//!
//! Thin like `commands::records`, and behind the same shared store. What the
//! window reaches here today is the write half — a worker's phase transitions
//! landing on the pulse — and the chat rows. The long-poll half stays on the
//! agent endpoint: a webview has Tauri events to wake on and never needs to
//! park an IPC call, which is why this host wires no waiter registry.

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use boite_core::command::Conduct;
use boite_core::scope::ProjectRoots;

use super::bus::{through, DesktopHost};
use super::records::Rows;

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
            params: Option<Value>,
        ) -> Result<Value, String> {
            let command = decode($method, params.unwrap_or_else(|| json!({})))?;
            let store = rows.get(&app)?;
            through(
                DesktopHost::new(scope.inner()).with_store(store),
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
