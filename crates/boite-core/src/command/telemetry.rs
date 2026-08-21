//! Consent, export, forget, and the few events the webview is the source of.
//!
//! Grant::Local only. An agent cannot flip consent, read an install_id, or
//! inject events. The rest of the events are emitted in Rust where they
//! happen (`thread.create`, boot, close); these methods exist because the
//! updater plugin and the pane tree live in the window.

use serde_json::{json, Value};

use crate::capability::{Capability, Grant};
use crate::telemetry::{TelemetryRuntime, UiState};

use super::{bool_param, opt_str_param, str_param, value_of, Host, Ready, Wire};

pub const ALL_METHODS: &[&str] = &[
    "telemetry.state",
    "telemetry.setModeA",
    "telemetry.setModeB",
    "telemetry.completeOnboarding",
    "telemetry.export",
    "telemetry.retryForget",
    "telemetry.trackUpdate",
    "telemetry.trackPane",
    "telemetry.trackSettingsSnapshot",
];

const LOCAL_ONLY: &str =
    "only Boite's own window reads or changes telemetry; an agent cannot";

#[derive(Debug, Clone)]
pub enum Telemetry {
    State,
    SetModeA { enabled: bool },
    SetModeB { enabled: bool },
    CompleteOnboarding { mode_a: bool, mode_b: bool },
    Export,
    RetryForget,
    TrackUpdate {
        stage: String,
        target_version: Option<String>,
        error_code: Option<String>,
    },
    TrackPane { pane_kind: String },
    TrackSettingsSnapshot {
        ui_language: String,
        theme: String,
        thread_worktrees: bool,
        animations: String,
        mcp_yolo: bool,
        idle_autoclose: bool,
        orchestrator: bool,
        voice: bool,
    },
}

impl Telemetry {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        Ok(match method {
            "telemetry.state" => Telemetry::State,
            "telemetry.setModeA" => Telemetry::SetModeA {
                enabled: bool_param(params, "enabled", false),
            },
            "telemetry.setModeB" => Telemetry::SetModeB {
                enabled: bool_param(params, "enabled", false),
            },
            "telemetry.completeOnboarding" => Telemetry::CompleteOnboarding {
                mode_a: bool_param(params, "modeA", false),
                mode_b: bool_param(params, "modeB", false),
            },
            "telemetry.export" => Telemetry::Export,
            "telemetry.retryForget" => Telemetry::RetryForget,
            "telemetry.trackUpdate" => Telemetry::TrackUpdate {
                stage: str_param(params, "stage")?,
                target_version: opt_str_param(params, "targetVersion"),
                error_code: opt_str_param(params, "errorCode"),
            },
            "telemetry.trackPane" => Telemetry::TrackPane {
                pane_kind: str_param(params, "paneKind")?,
            },
            "telemetry.trackSettingsSnapshot" => Telemetry::TrackSettingsSnapshot {
                ui_language: str_param(params, "uiLanguage")?,
                theme: str_param(params, "theme")?,
                thread_worktrees: bool_param(params, "threadWorktrees", false),
                animations: str_param(params, "animations")?,
                mcp_yolo: bool_param(params, "mcpYolo", false),
                idle_autoclose: bool_param(params, "idleAutoclose", false),
                orchestrator: bool_param(params, "orchestrator", false),
                voice: bool_param(params, "voice", false),
            },
            other => return Err(format!("unknown telemetry method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Telemetry::State => "telemetry.state",
            Telemetry::SetModeA { .. } => "telemetry.setModeA",
            Telemetry::SetModeB { .. } => "telemetry.setModeB",
            Telemetry::CompleteOnboarding { .. } => "telemetry.completeOnboarding",
            Telemetry::Export => "telemetry.export",
            Telemetry::RetryForget => "telemetry.retryForget",
            Telemetry::TrackUpdate { .. } => "telemetry.trackUpdate",
            Telemetry::TrackPane { .. } => "telemetry.trackPane",
            Telemetry::TrackSettingsSnapshot { .. } => "telemetry.trackSettingsSnapshot",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Telemetry::State | Telemetry::Export => Wire::Bare,
            _ => Wire::Ok,
        }
    }

    pub(super) fn capability(&self) -> Capability {
        match self {
            Telemetry::State | Telemetry::Export => Capability::ReadProject,
            _ => Capability::MutateProject,
        }
    }

    pub(super) fn prepare(self, host: &dyn Host, grant: Grant) -> Result<Ready, String> {
        if grant != Grant::Local {
            return Err(LOCAL_ONLY.to_string());
        }
        let runtime = host.telemetry().ok_or(
            "this Boite has no telemetry runtime, so there is nothing to read or write",
        )?;
        Ok(Ready::Telemetry(self, runtime))
    }

    pub(super) fn run(self, runtime: &TelemetryRuntime) -> Result<Value, String> {
        Ok(match self {
            Telemetry::State => value_of(runtime.ui_state()),
            Telemetry::SetModeA { enabled } => {
                runtime.set_mode_a(enabled)?;
                json!(null)
            }
            Telemetry::SetModeB { enabled } => {
                runtime.set_mode_b(enabled)?;
                json!(null)
            }
            Telemetry::CompleteOnboarding { mode_a, mode_b } => {
                runtime.complete_onboarding(mode_a, mode_b)?;
                json!(null)
            }
            Telemetry::Export => runtime.export()?,
            Telemetry::RetryForget => {
                runtime.retry_forget()?;
                json!(null)
            }
            Telemetry::TrackUpdate {
                stage,
                target_version,
                error_code,
            } => {
                runtime.track_update(&stage, target_version, error_code);
                json!(null)
            }
            Telemetry::TrackPane { pane_kind } => {
                runtime.track(crate::telemetry::Event::PaneOpened { pane_kind });
                json!(null)
            }
            Telemetry::TrackSettingsSnapshot {
                ui_language,
                theme,
                thread_worktrees,
                animations,
                mcp_yolo,
                idle_autoclose,
                orchestrator,
                voice,
            } => {
                runtime.track(crate::telemetry::Event::SettingsSnapshot {
                    ui_language,
                    theme,
                    thread_worktrees,
                    animations,
                    mcp_yolo,
                    idle_autoclose,
                    orchestrator,
                    voice,
                });
                json!(null)
            }
        })
    }
}

impl From<UiState> for Value {
    fn from(state: UiState) -> Self {
        value_of(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::{Command, Scoped};
    use crate::scope::ProjectRoots;

    fn decode(method: &str) -> Telemetry {
        let params = serde_json::json!({
            "enabled": true,
            "modeA": true,
            "modeB": false,
            "stage": "available",
            "paneKind": "editor",
            "uiLanguage": "fr",
            "theme": "dark",
            "threadWorktrees": true,
            "animations": "system",
            "mcpYolo": false,
            "idleAutoclose": true,
            "orchestrator": false,
            "voice": false,
        });
        match Command::decode(method, &params).unwrap() {
            Command::Telemetry(t) => t,
            other => panic!("{} decoded as {}", method, other.name()),
        }
    }

    #[test]
    fn an_agent_cannot_prepare_any_telemetry_command() {
        let roots = ProjectRoots::default();
        let host = Scoped::new(&roots);
        for method in ALL_METHODS {
            let command = Command::Telemetry(decode(method));
            let err = command
                .prepare(&host, Grant::Owner)
                .expect_err(method);
            assert!(
                err.contains("agent cannot"),
                "{method} refused with {err}"
            );
        }
    }

    #[test]
    fn a_host_without_a_runtime_says_so() {
        let roots = ProjectRoots::default();
        let host = Scoped::new(&roots);
        let err = Command::Telemetry(Telemetry::State)
            .prepare(&host, Grant::Local)
            .expect_err("no runtime");
        assert!(err.contains("no telemetry runtime"), "{err}");
    }
}
