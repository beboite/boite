//! This app's door onto consent, export, forget, and the few events the
//! webview is the source of.
//!
//! A codec, like every other file beside it: the trust boundary, the work and
//! the refusals all live in `boite_core::command`, and what is left here is
//! naming the command and handing over what the webview sent.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use boite_core::command::{Command, Telemetry};
use boite_core::scope::ProjectRoots;
use boite_core::telemetry::TelemetryRuntime;

use super::bus::{self, DesktopHost};

async fn on_telemetry(
    app: &AppHandle,
    scope: &ProjectRoots,
    command: Telemetry,
) -> Result<Value, String> {
    let Some(runtime) = app.try_state::<Arc<TelemetryRuntime>>() else {
        return Err(
            "this Boite has no telemetry runtime, so there is nothing to read or write".into(),
        );
    };
    bus::through(
        DesktopHost::new(scope).with_telemetry(runtime.inner().clone()),
        Command::Telemetry(command),
    )
    .await
}

fn decode(method: &str, params: Value) -> Result<Telemetry, String> {
    match Command::decode(method, &params)? {
        Command::Telemetry(command) => Ok(command),
        other => Err(format!("{} is not a telemetry command", other.name())),
    }
}

macro_rules! telemetry_command {
    ($name:ident, $method:literal) => {
        #[tauri::command]
        pub async fn $name(
            app: AppHandle,
            scope: State<'_, ProjectRoots>,
            params: Option<Value>,
        ) -> Result<Value, String> {
            let command = decode($method, params.unwrap_or_else(|| json!({})))?;
            on_telemetry(&app, scope.inner(), command).await
        }
    };
}

telemetry_command!(telemetry_state, "telemetry.state");
telemetry_command!(telemetry_set_mode_a, "telemetry.setModeA");
telemetry_command!(telemetry_set_mode_b, "telemetry.setModeB");
telemetry_command!(telemetry_complete_onboarding, "telemetry.completeOnboarding");
telemetry_command!(telemetry_export, "telemetry.export");
telemetry_command!(telemetry_retry_forget, "telemetry.retryForget");
telemetry_command!(telemetry_track_update, "telemetry.trackUpdate");
telemetry_command!(telemetry_track_pane, "telemetry.trackPane");
telemetry_command!(telemetry_track_settings_snapshot, "telemetry.trackSettingsSnapshot");
