//! Process-wide telemetry owner: sidecar, RAM queue, consent mutations.
//!
//! One of these lives on each host (`Host::telemetry`). Commands on the bus
//! call into it; they do not talk to the Worker themselves.

use super::client::{self, ConsentChoice, TELEMETRY_URL};
use super::events::{Event, TelemetryContext, UpdateStage};
use super::install_id;
use super::queue::{ConsentState, Handle, QueueParams, Worker};
use super::sidecar::{self, Sidecar};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long process exit waits for the final flush.
const SHUTDOWN_FLUSH_DEADLINE: Duration = Duration::from_millis(2500);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub mode_a_enabled: bool,
    pub mode_b_enabled: bool,
    pub install_id_set: bool,
    pub forget_pending: bool,
    pub onboarding_completed: bool,
}

pub struct TelemetryRuntime {
    handle: Handle,
    worker: Mutex<Option<Worker>>,
    sidecar_path: PathBuf,
    sidecar: Mutex<Sidecar>,
    app_start: Instant,
    app_version: String,
}

impl std::fmt::Debug for TelemetryRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelemetryRuntime")
            .field("sidecar_path", &self.sidecar_path)
            .finish_non_exhaustive()
    }
}

impl TelemetryRuntime {
    /// Builds the runtime at host start. Reads the sidecar for initial consent.
    /// `app_start` is captured by the caller at process start so boot
    /// durations stay accurate regardless of when this runs in setup.
    pub fn spawn(
        data_dir: &Path,
        app_version: impl Into<String>,
        surface: &str,
        app_start: Instant,
    ) -> Self {
        let sidecar_path = sidecar::path_in(data_dir);
        let mut cfg = sidecar::load(&sidecar_path);
        if cfg.onboarding_completed
            && cfg.mode_a_enabled
            && !install_id::is_valid(&cfg.anonymous_id)
        {
            let anonymous_id = install_id::generate();
            cfg.anonymous_id = anonymous_id;
            let _ = sidecar::save(&sidecar_path, &cfg);
        }
        let app_version = app_version.into();
        let consent = consent_from_sidecar(&cfg);
        let tctx = context_for(app_version.clone(), surface);
        let worker = Worker::spawn(tctx, consent, QueueParams::default());
        Self {
            handle: worker.handle(),
            worker: Mutex::new(Some(worker)),
            sidecar_path,
            sidecar: Mutex::new(cfg),
            app_start,
            app_version,
        }
    }

    pub fn handle(&self) -> Handle {
        self.handle.clone()
    }

    pub fn track(&self, event: Event) {
        self.handle.track(event);
    }

    /// Clean shutdown called when the process is closing for good.
    pub fn shutdown(&self) {
        let taken = {
            let mut guard = self.worker.lock().unwrap_or_else(|e| e.into_inner());
            guard.take()
        };
        if let Some(worker) = taken {
            worker.shutdown(SHUTDOWN_FLUSH_DEADLINE);
        }
    }

    pub fn ui_state(&self) -> UiState {
        let cfg = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        UiState {
            mode_a_enabled: cfg.mode_a_enabled,
            mode_b_enabled: cfg.mode_b_enabled,
            install_id_set: !cfg.install_id.is_empty()
                || cfg
                    .pending_forget_install_ids
                    .iter()
                    .any(|id| !id.is_empty()),
            forget_pending: !cfg.pending_forget_install_ids.is_empty(),
            onboarding_completed: cfg.onboarding_completed,
        }
    }

    pub fn set_mode_a(&self, enabled: bool) -> Result<(), String> {
        let had_b = !enabled && {
            let cfg = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
            cfg.mode_b_enabled
        };
        self.update(|cfg| apply_mode_a(cfg, enabled))?;
        if had_b {
            self.retry_forget()?;
        }
        Ok(())
    }

    pub fn set_mode_b(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            self.update(apply_mode_b_opt_in)?;
            Ok(())
        } else {
            self.update(stage_mode_b_opt_out)?;
            self.retry_forget()
        }
    }

    pub fn complete_onboarding(&self, mode_a: bool, mode_b: bool) -> Result<(), String> {
        let choice = match (mode_a, mode_b) {
            (false, false) => ConsentChoice::Refused,
            (true, false) => ConsentChoice::Basic,
            (true, true) => ConsentChoice::Enhanced,
            (false, true) => return Err("mode_b_requires_mode_a".into()),
        };
        let first_answer = {
            let cfg = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
            !cfg.onboarding_completed
        };
        self.update(|cfg| {
            cfg.onboarding_completed = true;
            cfg.mode_a_enabled = mode_a;
            cfg.mode_b_enabled = mode_b;
            if mode_a && !install_id::is_valid(&cfg.anonymous_id) {
                cfg.anonymous_id = install_id::generate();
            }
            if mode_b && cfg.install_id.is_empty() {
                cfg.install_id = install_id::generate();
            }
        })?;
        self.maybe_first_run();
        // `on_boot_complete` already fired, and the queue dropped `app_launched`
        // because consent did not exist yet. Replay it now that the answer is
        // in, so the first session still reports how long boot took.
        if first_answer && mode_a {
            self.track(Event::AppLaunched {
                duration_ms: self.boot_duration_ms(),
            });
        }
        // This one aggregate is recorded even for a refusal so the three
        // choices have an unbiased denominator. It runs best-effort on a
        // side thread and never delays or changes the selected mode.
        if client::is_inert(TELEMETRY_URL) {
            return Ok(());
        }
        let app_version = self.app_version.clone();
        std::thread::Builder::new()
            .name("boite-telemetry-consent".into())
            .spawn(move || {
                let ua = client::user_agent(&app_version);
                let http = match reqwest::blocking::Client::builder()
                    .user_agent(ua.clone())
                    .timeout(Duration::from_secs(5))
                    .build()
                {
                    Ok(http) => http,
                    Err(_) => return,
                };
                let _ = client::record_consent_choice(
                    &http,
                    TELEMETRY_URL,
                    &ua,
                    choice,
                    &app_version,
                );
            })
            .map_err(|e| format!("consent thread: {e}"))?;
        Ok(())
    }

    pub fn retry_forget(&self) -> Result<(), String> {
        let pending = {
            let cfg = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
            cfg.pending_forget_install_ids.clone()
        };
        if pending.is_empty() {
            return Ok(());
        }
        let ua = client::user_agent(&self.app_version);
        let http = reqwest::blocking::Client::builder()
            .user_agent(ua.clone())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("client: {e}"))?;
        process_pending_forgets(
            &pending,
            |install_id| client::forget(&http, TELEMETRY_URL, &ua, install_id),
            |install_id| {
                self.update(|cfg| {
                    complete_mode_b_forget(cfg, install_id);
                })
            },
        )
    }

    pub fn export(&self) -> Result<Value, String> {
        let ids = {
            let cfg = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
            telemetry_install_ids(&cfg)
        };
        if ids.is_empty() {
            return Err("mode_b_disabled".into());
        }
        let ua = client::user_agent(&self.app_version);
        let http = reqwest::blocking::Client::builder()
            .user_agent(ua.clone())
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| format!("client: {e}"))?;
        let mut exports = Vec::with_capacity(ids.len());
        for install_id in ids {
            exports.push(client::export(&http, TELEMETRY_URL, &ua, &install_id)?);
        }
        if exports.len() == 1 {
            Ok(exports.pop().expect("one export"))
        } else {
            Ok(json!({ "installations": exports }))
        }
    }

    pub fn track_update(
        &self,
        stage: &str,
        target_version: Option<String>,
        error_code: Option<String>,
    ) {
        let stage = match stage {
            "available" => UpdateStage::Available,
            "downloaded" => UpdateStage::Downloaded,
            "applied" => UpdateStage::Applied,
            "failed" => UpdateStage::Failed,
            _ => return,
        };
        self.track(Event::Update {
            stage,
            target_version,
            error_code,
        });
    }

    fn boot_duration_ms(&self) -> u64 {
        self.app_start
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    /// First boot completion: `first_run` if this install has never reported
    /// one, then `app_launched`. `ping` is not emitted here: the queue owns it.
    ///
    /// Before onboarding the queue drops both. `complete_onboarding` re-emits
    /// `app_launched` once consent exists, so the first session is not silent.
    pub fn on_boot_complete(&self) {
        self.maybe_first_run();
        self.track(Event::AppLaunched {
            duration_ms: self.boot_duration_ms(),
        });
    }

    pub fn on_session_end(&self) {
        self.track(Event::SessionEnded {
            duration_ms: self.boot_duration_ms(),
        });
    }

    /// Mode B workspace size. Counts only, never names or paths.
    pub fn track_workspace_from(&self, store: &crate::store::Store, live_pty_count: u64) {
        let project_count = store.load_projects().map(|p| p.len() as u64).unwrap_or(0);
        let thread_count = store.load_threads().map(|t| t.len() as u64).unwrap_or(0);
        self.track(Event::WorkspaceSnapshot {
            project_count,
            thread_count,
            live_pty_count,
        });
    }

    fn maybe_first_run(&self) {
        let should = {
            let cfg = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
            cfg.onboarding_completed
                && !cfg.first_run_reported
                && (cfg.mode_a_enabled || cfg.mode_b_enabled)
        };
        if !should {
            return;
        }
        self.track(Event::FirstRun);
        let _ = self.update(|cfg| {
            cfg.first_run_reported = true;
        });
    }

    fn update(&self, f: impl FnOnce(&mut Sidecar)) -> Result<(), String> {
        {
            let mut cfg = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut cfg);
            sidecar::save(&self.sidecar_path, &cfg)?;
        }
        self.refresh_consent();
        Ok(())
    }

    fn refresh_consent(&self) {
        let cfg = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        self.handle.update_consent(consent_from_sidecar(&cfg));
    }
}

/// Converts the persisted sidecar into an in-memory consent state.
pub fn consent_from_sidecar(cfg: &Sidecar) -> ConsentState {
    ConsentState {
        mode_a: cfg.onboarding_completed && cfg.mode_a_enabled,
        mode_b: cfg.onboarding_completed && cfg.mode_b_enabled && !cfg.install_id.is_empty(),
        install_id: if cfg.install_id.is_empty() {
            None
        } else {
            Some(cfg.install_id.clone())
        },
        anonymous_id: if cfg.anonymous_id.is_empty() {
            None
        } else {
            Some(cfg.anonymous_id.clone())
        },
    }
}

/// Builds the invariant context every event is merged with.
pub fn context_for(app_version: impl Into<String>, surface: &str) -> TelemetryContext {
    TelemetryContext {
        app_version: app_version.into(),
        os: super::detect_os().to_string(),
        arch: super::detect_arch().to_string(),
        os_version: super::detect_os_version(),
        locale: super::detect_locale(),
        surface: surface.to_string(),
    }
}

fn apply_mode_a(cfg: &mut Sidecar, enabled: bool) {
    cfg.mode_a_enabled = enabled;
    if enabled {
        if !install_id::is_valid(&cfg.anonymous_id) {
            cfg.anonymous_id = install_id::generate();
        }
    } else if cfg.mode_b_enabled {
        stage_mode_b_opt_out(cfg);
    }
}

fn apply_mode_b_opt_in(cfg: &mut Sidecar) {
    cfg.mode_a_enabled = true;
    cfg.mode_b_enabled = true;
    if !install_id::is_valid(&cfg.anonymous_id) {
        cfg.anonymous_id = install_id::generate();
    }
    if cfg.install_id.is_empty() {
        cfg.install_id = install_id::generate();
    }
}

fn stage_mode_b_opt_out(cfg: &mut Sidecar) {
    cfg.mode_b_enabled = false;
    let install_id = std::mem::take(&mut cfg.install_id);
    if !install_id.is_empty()
        && !cfg
            .pending_forget_install_ids
            .iter()
            .any(|pending| pending == &install_id)
    {
        cfg.pending_forget_install_ids.push(install_id);
    }
}

fn complete_mode_b_forget(cfg: &mut Sidecar, install_id: &str) {
    cfg.pending_forget_install_ids
        .retain(|pending| pending != install_id);
}

fn telemetry_install_ids(cfg: &Sidecar) -> Vec<String> {
    let mut ids = Vec::with_capacity(1 + cfg.pending_forget_install_ids.len());
    if !cfg.install_id.is_empty() {
        ids.push(cfg.install_id.clone());
    }
    for id in &cfg.pending_forget_install_ids {
        if !id.is_empty() && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    ids
}

fn process_pending_forgets(
    pending: &[String],
    mut forget: impl FnMut(&str) -> Result<(), String>,
    mut acknowledge: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    for install_id in pending {
        forget(install_id)?;
        acknowledge(install_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD_ID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const NEW_ID: &str = "797f20fe-94de-4e89-98a2-ae3a3273ad1e";

    #[test]
    fn consent_from_sidecar_strips_mode_b_when_install_id_empty() {
        let cfg = Sidecar {
            mode_a_enabled: true,
            mode_b_enabled: true,
            install_id: String::new(),
            pending_forget_install_ids: Vec::new(),
            anonymous_id: String::new(),
            onboarding_completed: true,
            first_run_reported: true,
        };
        let state = consent_from_sidecar(&cfg);
        assert!(state.mode_a);
        assert!(!state.mode_b, "mode B must require a non-empty install_id");
        assert!(state.install_id.is_none());
    }

    #[test]
    fn consent_from_sidecar_default_sends_nothing_before_onboarding() {
        let cfg = Sidecar::default();
        let state = consent_from_sidecar(&cfg);
        assert!(!state.mode_a);
        assert!(!state.mode_b);
    }

    #[test]
    fn disabling_mode_a_stages_mode_b_forget() {
        let mut cfg = Sidecar {
            mode_a_enabled: true,
            mode_b_enabled: true,
            install_id: OLD_ID.into(),
            ..Default::default()
        };
        apply_mode_a(&mut cfg, false);
        assert!(!cfg.mode_a_enabled);
        assert!(!cfg.mode_b_enabled);
        assert!(cfg.install_id.is_empty());
        assert_eq!(cfg.pending_forget_install_ids, [OLD_ID]);
    }

    #[test]
    fn enabling_mode_b_turns_mode_a_on() {
        let mut cfg = Sidecar::default();
        apply_mode_b_opt_in(&mut cfg);
        assert!(cfg.mode_a_enabled);
        assert!(cfg.mode_b_enabled);
        assert!(!cfg.install_id.is_empty());
        assert!(install_id::is_valid(&cfg.anonymous_id));
    }

    #[test]
    fn opt_out_stops_mode_b_and_preserves_identifier_for_retry() {
        let mut cfg = Sidecar {
            mode_b_enabled: true,
            install_id: OLD_ID.into(),
            ..Default::default()
        };
        stage_mode_b_opt_out(&mut cfg);
        assert!(!cfg.mode_b_enabled);
        assert!(cfg.install_id.is_empty());
        assert_eq!(cfg.pending_forget_install_ids, [OLD_ID]);
    }

    #[test]
    fn repeated_opt_out_does_not_duplicate_pending_identifier() {
        let mut cfg = Sidecar {
            mode_b_enabled: true,
            install_id: OLD_ID.into(),
            pending_forget_install_ids: vec![OLD_ID.into()],
            ..Default::default()
        };
        stage_mode_b_opt_out(&mut cfg);
        assert_eq!(cfg.pending_forget_install_ids, [OLD_ID]);
    }

    #[test]
    fn forget_completion_does_not_clear_a_new_opt_in() {
        let mut cfg = Sidecar {
            mode_b_enabled: true,
            install_id: NEW_ID.into(),
            pending_forget_install_ids: vec![OLD_ID.into()],
            ..Default::default()
        };
        complete_mode_b_forget(&mut cfg, OLD_ID);
        assert!(cfg.pending_forget_install_ids.is_empty());
        assert_eq!(cfg.install_id, NEW_ID);
        assert!(cfg.mode_b_enabled);
    }

    #[test]
    fn export_includes_active_and_pending_installations_once() {
        let cfg = Sidecar {
            install_id: NEW_ID.into(),
            pending_forget_install_ids: vec![OLD_ID.into(), NEW_ID.into()],
            ..Default::default()
        };
        assert_eq!(telemetry_install_ids(&cfg), [NEW_ID, OLD_ID]);
    }

    #[test]
    fn failed_forget_is_not_acknowledged_locally() {
        let pending = vec![OLD_ID.to_string()];
        let mut acknowledged = Vec::new();
        let result = process_pending_forgets(
            &pending,
            |_| Err("offline".into()),
            |install_id| {
                acknowledged.push(install_id.to_string());
                Ok(())
            },
        );
        assert_eq!(result, Err("offline".into()));
        assert!(acknowledged.is_empty());
    }

    #[test]
    fn successful_forgets_are_acknowledged_one_by_one() {
        let pending = vec![OLD_ID.to_string(), NEW_ID.to_string()];
        let mut attempted = Vec::new();
        let mut acknowledged = Vec::new();
        let result = process_pending_forgets(
            &pending,
            |install_id| {
                attempted.push(install_id.to_string());
                if install_id == NEW_ID {
                    Err("worker unavailable".into())
                } else {
                    Ok(())
                }
            },
            |install_id| {
                acknowledged.push(install_id.to_string());
                Ok(())
            },
        );
        assert_eq!(result, Err("worker unavailable".into()));
        assert_eq!(attempted, [OLD_ID, NEW_ID]);
        assert_eq!(acknowledged, [OLD_ID]);
    }
}
