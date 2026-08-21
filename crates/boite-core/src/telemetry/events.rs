/// Telemetry events emitted by a boite.
///
/// An `Event` only carries the variable fields specific to that event. Stable
/// per-session fields (app_version, os, arch, os_version, locale, surface)
/// live in `TelemetryContext` and are merged at serialization time.
#[derive(Debug, Clone)]
pub enum Event {
    /// Daily ping for DAU / MAU measurement.
    ///
    /// Emitted by the queue itself, not by a caller: it has to fire once a day
    /// for as long as the process lives, and it carries the number of events
    /// the queue had to drop since the previous ping, which only the queue
    /// knows.
    Ping { dropped_events: u64 },
    /// First launch of this installation that knew how to report one.
    FirstRun,
    /// App launch time (between process start and the first frame, or the
    /// server finishing its bind).
    AppLaunched { duration_ms: u64 },
    /// End of session with total duration. Clean close only.
    SessionEnded { duration_ms: u64 },
    /// A thread row was created, not a re-save of one that already existed.
    ThreadSpawned { kind: String, provider: String },
    /// A thread row was deleted.
    ThreadClosed { kind: String },
    /// A project row was created.
    ProjectAdded,
    /// A pane of a given kind was opened in a group that did not already
    /// have one. Kind only, never a path or a title.
    PaneOpened { pane_kind: String },
    /// A named operation failed. `operation` and `error_code` both come from
    /// fixed vocabularies, so no user data can reach this event.
    OperationFailed {
        operation: String,
        error_code: String,
    },
    /// A stage of the in-app update flow.
    Update {
        stage: UpdateStage,
        target_version: Option<String>,
        error_code: Option<String>,
    },
    /// Snapshot of workspace size. Mode B only (requires a stable install_id).
    WorkspaceSnapshot {
        project_count: u64,
        thread_count: u64,
        live_pty_count: u64,
    },
    /// Snapshot of the non-identifying app settings, once per launch.
    ///
    /// Mode B only. Each field is low-entropy on its own, but several of them
    /// together are a weak fingerprint, and Mode A exists precisely so that
    /// two events cannot be tied to the same installation across days.
    SettingsSnapshot {
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

/// Stage of the updater flow. Each maps to its own PostHog event name so a
/// funnel can be built without unpacking a property.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStage {
    Available,
    Downloaded,
    Applied,
    Failed,
}

impl Event {
    pub fn name(&self) -> &'static str {
        match self {
            Event::Ping { .. } => "ping",
            Event::FirstRun => "first_run",
            Event::AppLaunched { .. } => "app_launched",
            Event::SessionEnded { .. } => "session_ended",
            Event::ThreadSpawned { .. } => "thread_spawned",
            Event::ThreadClosed { .. } => "thread_closed",
            Event::ProjectAdded => "project_added",
            Event::PaneOpened { .. } => "pane_opened",
            Event::OperationFailed { .. } => "operation_failed",
            Event::Update { stage, .. } => match stage {
                UpdateStage::Available => "update_available",
                UpdateStage::Downloaded => "update_downloaded",
                UpdateStage::Applied => "update_applied",
                UpdateStage::Failed => "update_failed",
            },
            Event::WorkspaceSnapshot { .. } => "workspace_snapshot",
            Event::SettingsSnapshot { .. } => "settings_snapshot",
        }
    }

    /// True for events that require a stable install_id to mean anything, and
    /// that the queue drops before a Mode A upload.
    pub fn is_mode_b_only(&self) -> bool {
        matches!(
            self,
            Event::WorkspaceSnapshot { .. } | Event::SettingsSnapshot { .. }
        )
    }
}

/// The value every unrecognised code collapses to.
pub const UNKNOWN_CODE: &str = "other";

/// Every error code that may reach the network.
///
/// A closed vocabulary rather than a sanitizer. Normalising an arbitrary
/// string is not enough: `C:\Users\alice\...` survives character filtering
/// with the account name intact, and an error message is exactly the kind of
/// string that carries paths and usernames. Anything not listed here becomes
/// `other`, so a caller that passes a raw message leaks a category at worst.
pub const ERROR_CODES: &[&str] = &[
    "check_failed",
    "download_failed",
    "install_failed",
    "relaunch_failed",
    "io",
    "network",
    UNKNOWN_CODE,
];

/// Every operation name that may reach the network.
pub const OPERATIONS: &[&str] = &[
    "thread_create",
    "project_create",
    "pane_open",
    "update",
    "snapshot",
    UNKNOWN_CODE,
];

/// The ten agent adapters, plus a shell and the collapse value.
pub const PROVIDERS: &[&str] = &[
    "claude",
    "codex",
    "antigravity",
    "cursor",
    "copilot",
    "opencode",
    "grok",
    "hermes",
    "pi",
    "muse",
    "shell",
    UNKNOWN_CODE,
];

/// Pane kinds a group can hold. A dashboard pane maps to `home`.
pub const PANE_KINDS: &[&str] = &[
    "terminal",
    "editor",
    "browser",
    "git",
    "explorer",
    "todo",
    "home",
    "settings",
    UNKNOWN_CODE,
];

/// Shipped palettes plus `system`. A custom name becomes `other`.
pub const THEMES: &[&str] = &[
    "dark",
    "light",
    "midnight",
    "acrylic_black",
    "acrylic_white",
    "system",
    UNKNOWN_CODE,
];

/// UI languages the app ships. An unlisted value becomes `other` rather than
/// travelling as typed.
pub const UI_LANGUAGES: &[&str] = &["en", "fr", "system", UNKNOWN_CODE];

/// Motion setting the app ships.
pub const ANIMATIONS: &[&str] = &["system", "on", "off", UNKNOWN_CODE];

/// Whether a thread is an agent or a shell.
pub const THREAD_KINDS: &[&str] = &["agent", "shell", UNKNOWN_CODE];

const AGENT_PROVIDERS: &[&str] = &[
    "claude",
    "codex",
    "antigravity",
    "cursor",
    "copilot",
    "opencode",
    "grok",
    "hermes",
    "pi",
    "muse",
];

/// Maximum length of a normalized identifier-like value.
const MAX_CODE_LEN: usize = 40;

/// Normalizes a string to lowercase `[a-z0-9_]`.
///
/// Shape only. On its own this is NOT a privacy boundary, which is why every
/// caller pairs it with [`code_from`] and a closed vocabulary.
pub fn sanitize_code(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_CODE_LEN));
    for ch in raw.trim().chars() {
        if out.len() == MAX_CODE_LEN {
            break;
        }
        let lowered = ch.to_ascii_lowercase();
        if lowered.is_ascii_alphanumeric() || lowered == '_' {
            out.push(lowered);
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        UNKNOWN_CODE.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Maps a value onto a closed vocabulary, or onto `other`.
///
/// The single gate that makes it impossible for a message, a path or a
/// project name to reach the network through a code field, whatever a caller
/// passes.
pub fn code_from(raw: &str, allowed: &[&'static str]) -> &'static str {
    let normalized = sanitize_code(raw);
    allowed
        .iter()
        .copied()
        .find(|candidate| *candidate == normalized)
        .unwrap_or(UNKNOWN_CODE)
}

/// Provider code from an icon key or a command stem.
pub fn provider_code(raw: &str) -> &'static str {
    code_from(raw, PROVIDERS)
}

/// Pane kind, with `dashboard` and `thread` mapped onto the shipped names.
pub fn pane_kind_code(raw: &str) -> &'static str {
    match raw {
        "thread" => "terminal",
        "dashboard" => "home",
        other => code_from(other, PANE_KINDS),
    }
}

/// Agent vs shell, from a provider code.
pub fn thread_kind_for_provider(provider: &str) -> &'static str {
    if AGENT_PROVIDERS.contains(&provider) {
        "agent"
    } else {
        "shell"
    }
}

/// `(kind, provider)` from a thread's command and icon. A shell reports
/// `provider=shell` rather than leaking the binary name.
pub fn classify_thread(cmd: &str, icon_key: Option<&str>) -> (&'static str, &'static str) {
    let from_icon = icon_key
        .map(provider_code)
        .filter(|code| AGENT_PROVIDERS.contains(code));
    let provider = from_icon.unwrap_or_else(|| {
        let stem = std::path::Path::new(cmd)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(cmd);
        let code = provider_code(stem);
        if AGENT_PROVIDERS.contains(&code) {
            code
        } else {
            "shell"
        }
    });
    (thread_kind_for_provider(provider), provider)
}

/// Stable session context (invariant for every request).
#[derive(Debug, Clone)]
pub struct TelemetryContext {
    pub app_version: String,
    /// Fixed identifier: `windows`, `macos`, `linux`.
    pub os: String,
    /// Target architecture: `x86_64`, `aarch64`.
    pub arch: String,
    /// Human-readable OS version, for support decisions.
    pub os_version: String,
    pub locale: Option<String>,
    /// `desktop` or `server`.
    pub surface: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_normalizes_shape() {
        assert_eq!(sanitize_code("Account Not Found"), "account_not_found");
        assert_eq!(sanitize_code("io"), "io");
        assert_eq!(sanitize_code("  spaced  "), "spaced");
        assert_eq!(sanitize_code("acrylic-black"), "acrylic_black");
    }

    #[test]
    fn sanitize_never_returns_empty() {
        assert_eq!(sanitize_code(""), UNKNOWN_CODE);
        assert_eq!(sanitize_code("   "), UNKNOWN_CODE);
        assert_eq!(sanitize_code("!!!"), UNKNOWN_CODE);
    }

    #[test]
    fn sanitize_truncates_long_input() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_code(&long).len(), MAX_CODE_LEN);
    }

    #[test]
    fn a_raw_message_cannot_leak_through_a_code_field() {
        let code = code_from(r"C:\Users\alice\project\foo missing", ERROR_CODES);
        assert_eq!(code, UNKNOWN_CODE);
    }

    #[test]
    fn known_codes_survive_the_vocabulary() {
        assert_eq!(code_from("check_failed", ERROR_CODES), "check_failed");
        assert_eq!(code_from("Check Failed", ERROR_CODES), "check_failed");
        assert_eq!(code_from("pt-BR", UI_LANGUAGES), UNKNOWN_CODE);
        assert_eq!(code_from("fr", UI_LANGUAGES), "fr");
        assert_eq!(code_from("klingon", UI_LANGUAGES), UNKNOWN_CODE);
        assert_eq!(provider_code("claude"), "claude");
        assert_eq!(provider_code("MyPrivateCli"), UNKNOWN_CODE);
        assert_eq!(pane_kind_code("thread"), "terminal");
        assert_eq!(pane_kind_code("dashboard"), "home");
        assert_eq!(pane_kind_code("browser"), "browser");
        assert_eq!(pane_kind_code("secret-panel"), UNKNOWN_CODE);
    }

    #[test]
    fn snapshot_events_are_the_only_mode_b_only_ones() {
        assert!(Event::WorkspaceSnapshot {
            project_count: 1,
            thread_count: 2,
            live_pty_count: 1,
        }
        .is_mode_b_only());
        assert!(Event::SettingsSnapshot {
            ui_language: "fr".into(),
            theme: "dark".into(),
            thread_worktrees: true,
            animations: "system".into(),
            mcp_yolo: false,
            idle_autoclose: true,
            orchestrator: false,
            voice: false,
        }
        .is_mode_b_only());
        assert!(!Event::Ping { dropped_events: 0 }.is_mode_b_only());
        assert!(!Event::ProjectAdded.is_mode_b_only());
    }

    #[test]
    fn update_stages_have_distinct_event_names() {
        let names: Vec<&str> = [
            UpdateStage::Available,
            UpdateStage::Downloaded,
            UpdateStage::Applied,
            UpdateStage::Failed,
        ]
        .into_iter()
        .map(|stage| {
            Event::Update {
                stage,
                target_version: None,
                error_code: None,
            }
            .name()
        })
        .collect();
        assert_eq!(
            names,
            [
                "update_available",
                "update_downloaded",
                "update_applied",
                "update_failed"
            ]
        );
    }

    #[test]
    fn a_known_adapter_is_an_agent_and_anything_else_is_a_shell() {
        assert_eq!(thread_kind_for_provider("claude"), "agent");
        assert_eq!(thread_kind_for_provider("shell"), "shell");
        assert_eq!(thread_kind_for_provider("other"), "shell");
    }
}
