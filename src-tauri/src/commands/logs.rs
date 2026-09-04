//! This app's door onto the log.
//!
//! A codec, like every other file beside it: the ring, the files, the filter
//! and the refusals live in `boite_core::log`, reached through
//! `boite_core::command::logs`, and what is left here is naming the method and
//! handing over what the webview sent.
//!
//! `logs.write` is the only road out of the webview now. What is left in
//! [`super::app`] is `clear_app_log` and `log_file_path`, which are about the
//! file rather than about a record: the Logs section still empties it and still
//! says where it is.

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

/// The one whose effect is on this side.
///
/// The bus answers whether the caller may be pushed to and does nothing else,
/// because who to push at is a property of the transport. Here the transport is
/// one Tauri event to one webview, so the gate lives beside the batcher that
/// feeds it. Written after the bus has agreed, never before: a refusal that
/// still turned the feed on would push records at a caller that was told no.
#[tauri::command]
pub async fn logs_subscribe(
    scope: State<'_, ProjectRoots>,
    params: Option<Value>,
) -> Result<Value, String> {
    let params = params.unwrap_or_else(|| json!({}));
    let on = params.get("on").and_then(|v| v.as_bool()).unwrap_or(true);
    let command = decode("logs.subscribe", params)?;
    let answer = on_bus(scope.inner(), Command::Logs(command)).await?;
    crate::log_feed::set_watching(on);
    Ok(answer)
}
