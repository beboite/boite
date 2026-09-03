//! This app's door onto the log.
//!
//! A codec, like every other file beside it: the ring, the files, the filter
//! and the refusals live in `boite_core::log`, reached through
//! `boite_core::command::logs`, and what is left here is naming the method and
//! handing over what the webview sent.
//!
//! The four older commands (`log_app_event`, `read_app_log`, `clear_app_log`,
//! `log_file_path`) stay in [`super::app`] and now write through the same
//! module, so the diagnostics panel keeps working while the webview moves onto
//! these at its own pace.

use serde_json::{json, Value};
use tauri::State;

use boite_core::command::{Command, Logs};
use boite_core::scope::ProjectRoots;

use super::bus::on_bus;

fn decode(method: &str, params: Value) -> Result<Logs, String> {
    match Command::decode(method, &params)? {
        Command::Logs(command) => Ok(command),
        other => Err(format!("{} is not a logs command", other.name())),
    }
}

macro_rules! logs_command {
    ($name:ident, $method:literal) => {
        #[tauri::command]
        pub async fn $name(
            scope: State<'_, ProjectRoots>,
            params: Option<Value>,
        ) -> Result<Value, String> {
            let command = decode($method, params.unwrap_or_else(|| json!({})))?;
            on_bus(scope.inner(), Command::Logs(command)).await
        }
    };
}

logs_command!(logs_tail, "logs.tail");
logs_command!(logs_query, "logs.query");
logs_command!(logs_level, "logs.level");
logs_command!(logs_write, "logs.write");
logs_command!(logs_subscribe, "logs.subscribe");
