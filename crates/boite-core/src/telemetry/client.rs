use super::events::{
    code_from, pane_kind_code, provider_code, Event, TelemetryContext, ANIMATIONS, ERROR_CODES,
    OPERATIONS, THEMES, THREAD_KINDS, UI_LANGUAGES,
};
use super::time::to_rfc3339_utc;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::time::{Duration, SystemTime};

/// Inert placeholder used when `BOITE_TELEMETRY_URL` is not set at compile
/// time. Not a live endpoint on purpose: it only marks builds that forgot to
/// set the variable so telemetry calls fail instead of silently pointing at
/// someone else's infrastructure.
const TELEMETRY_URL_FALLBACK: &str = "https://telemetry.invalid";

/// Telemetry Worker URL.
///
/// Must be set at compile time via `BOITE_TELEMETRY_URL=...`. An empty value
/// (a GitHub secret that exists but was never filled) is the same as unset:
/// you cannot match on `""` in a const, so the raw string is read first.
const RAW_TELEMETRY_URL: &str = match option_env!("BOITE_TELEMETRY_URL") {
    Some(url) => url,
    None => "",
};
pub const TELEMETRY_URL: &str = if RAW_TELEMETRY_URL.is_empty() {
    TELEMETRY_URL_FALLBACK
} else {
    RAW_TELEMETRY_URL
};

/// True when the compiled URL is the inert placeholder. A local `tauri dev`
/// without `BOITE_TELEMETRY_URL` used to sit on a 5s timeout against `.invalid`
/// then back off for an hour, on every flush. Skip the socket instead.
pub fn is_inert(url: &str) -> bool {
    url.is_empty() || url.contains("telemetry.invalid")
}

/// User-Agent sent with every request.
/// Must match `UA_PREFIX` on the Worker (rejected otherwise).
pub fn user_agent(app_version: &str) -> String {
    format!("Boite/{app_version} (telemetry)")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    A,
    B,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::A => "A",
            Mode::B => "B",
        }
    }
}

/// Maximum length of a version string sent as a property.
const MAX_VERSION_LEN: usize = 32;

/// Reduces a version string to digits, letters, dots and dashes.
///
/// The updater hands us whatever the release manifest declared, which is
/// remote input. It has never been anything but a semver string, and this is
/// what keeps it that way.
fn sanitize_version(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '+')
        .take(MAX_VERSION_LEN)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Serializes an event to flat JSON for the `/track` endpoint.
///
/// `client_ts` is the instant the event happened, not the instant the batch
/// leaves: a batch covers up to a full flush interval, so a single
/// server-side stamp would flatten it.
pub fn event_to_json(event: &Event, ctx: &TelemetryContext, client_ts: SystemTime) -> Value {
    let mut m = Map::new();
    m.insert("name".into(), Value::from(event.name()));
    m.insert("app_version".into(), Value::from(ctx.app_version.clone()));
    m.insert("os".into(), Value::from(ctx.os.clone()));
    m.insert("arch".into(), Value::from(ctx.arch.clone()));
    m.insert("os_version".into(), Value::from(ctx.os_version.clone()));
    m.insert("surface".into(), Value::from(ctx.surface.clone()));
    m.insert("client_ts".into(), Value::from(to_rfc3339_utc(client_ts)));
    if let Some(locale) = &ctx.locale {
        m.insert("locale".into(), Value::from(locale.clone()));
    }
    match event {
        Event::Ping { dropped_events } => {
            // Only sent when non-zero: a queue that never overflowed must not
            // add a property to every single ping just to say so.
            if *dropped_events > 0 {
                m.insert("dropped_events".into(), Value::from(*dropped_events));
            }
        }
        Event::FirstRun => {}
        Event::AppLaunched { duration_ms } | Event::SessionEnded { duration_ms } => {
            m.insert("duration_ms".into(), Value::from(*duration_ms));
        }
        Event::ThreadSpawned { kind, provider } => {
            m.insert("kind".into(), Value::from(code_from(kind, THREAD_KINDS)));
            m.insert("provider".into(), Value::from(provider_code(provider)));
        }
        Event::ThreadClosed { kind } => {
            m.insert("kind".into(), Value::from(code_from(kind, THREAD_KINDS)));
        }
        Event::ProjectAdded => {}
        Event::PaneOpened { pane_kind } => {
            m.insert("pane_kind".into(), Value::from(pane_kind_code(pane_kind)));
        }
        Event::OperationFailed {
            operation,
            error_code,
        } => {
            m.insert(
                "operation".into(),
                Value::from(code_from(operation, OPERATIONS)),
            );
            m.insert(
                "error_code".into(),
                Value::from(code_from(error_code, ERROR_CODES)),
            );
        }
        Event::Update {
            target_version,
            error_code,
            ..
        } => {
            if let Some(version) = target_version.as_deref().and_then(sanitize_version) {
                m.insert("target_version".into(), Value::from(version));
            }
            if let Some(code) = error_code {
                m.insert(
                    "error_code".into(),
                    Value::from(code_from(code, ERROR_CODES)),
                );
            }
        }
        Event::WorkspaceSnapshot {
            project_count,
            thread_count,
            live_pty_count,
        } => {
            m.insert("project_count".into(), Value::from(*project_count));
            m.insert("thread_count".into(), Value::from(*thread_count));
            m.insert("live_pty_count".into(), Value::from(*live_pty_count));
        }
        Event::SettingsSnapshot {
            ui_language,
            theme,
            thread_worktrees,
            animations,
            mcp_yolo,
            idle_autoclose,
            orchestrator,
            voice,
        } => {
            m.insert(
                "ui_language".into(),
                Value::from(code_from(ui_language, UI_LANGUAGES)),
            );
            m.insert("theme".into(), Value::from(code_from(theme, THEMES)));
            m.insert("thread_worktrees".into(), Value::from(*thread_worktrees));
            m.insert(
                "animations".into(),
                Value::from(code_from(animations, ANIMATIONS)),
            );
            m.insert("mcp_yolo".into(), Value::from(*mcp_yolo));
            m.insert("idle_autoclose".into(), Value::from(*idle_autoclose));
            m.insert("orchestrator".into(), Value::from(*orchestrator));
            m.insert("voice".into(), Value::from(*voice));
        }
    }
    Value::Object(m)
}

#[derive(Serialize)]
struct TrackPayload<'a> {
    mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anonymous_id: Option<&'a str>,
    events: Vec<Value>,
}

/// Synchronous POST to `/track`. Returns Ok on 2xx, Err otherwise.
///
/// Short timeouts (~5s) so the background thread is not blocked too long.
pub fn send_batch(
    client: &reqwest::blocking::Client,
    base_url: &str,
    user_agent: &str,
    mode: Mode,
    identifier: Option<&str>,
    events_json: Vec<Value>,
) -> Result<(), String> {
    if events_json.is_empty() || is_inert(base_url) {
        return Ok(());
    }
    let payload = TrackPayload {
        mode: mode.as_str(),
        install_id: (mode == Mode::B).then_some(identifier).flatten(),
        anonymous_id: (mode == Mode::A).then_some(identifier).flatten(),
        events: events_json,
    };
    let url = format!("{base_url}/track");
    let res = client
        .post(&url)
        .header("User-Agent", user_agent)
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(5))
        .json(&payload)
        .send()
        .map_err(|e| format!("send: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("status: {}", res.status()));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentChoice {
    Refused,
    Basic,
    Enhanced,
}

impl ConsentChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Refused => "refused",
            Self::Basic => "basic",
            Self::Enhanced => "enhanced",
        }
    }
}

#[derive(Serialize)]
struct ConsentPayload<'a> {
    choice: &'static str,
    app_version: &'a str,
}

/// Increments an aggregate onboarding-choice counter. This intentionally
/// carries no installation identifier, including when the choice is refusal.
pub fn record_consent_choice(
    client: &reqwest::blocking::Client,
    base_url: &str,
    user_agent: &str,
    choice: ConsentChoice,
    app_version: &str,
) -> Result<(), String> {
    if is_inert(base_url) {
        return Ok(());
    }
    let url = format!("{base_url}/consent");
    let payload = ConsentPayload {
        choice: choice.as_str(),
        app_version,
    };
    let res = client
        .post(&url)
        .header("User-Agent", user_agent)
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(5))
        .json(&payload)
        .send()
        .map_err(|e| format!("send: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("status: {}", res.status()));
    }
    Ok(())
}

/// Calls `/forget` to delete data associated with an install_id.
pub fn forget(
    client: &reqwest::blocking::Client,
    base_url: &str,
    user_agent: &str,
    install_id: &str,
) -> Result<(), String> {
    if is_inert(base_url) {
        return Err("telemetry_inert".into());
    }
    let url = format!("{base_url}/forget");
    let res = client
        .post(&url)
        .header("User-Agent", user_agent)
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .json(&json!({ "install_id": install_id }))
        .send()
        .map_err(|e| format!("send: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("status: {}", res.status()));
    }
    Ok(())
}

/// Calls `/export` to retrieve raw JSON data for an install_id.
pub fn export(
    client: &reqwest::blocking::Client,
    base_url: &str,
    user_agent: &str,
    install_id: &str,
) -> Result<Value, String> {
    if is_inert(base_url) {
        return Err("telemetry_inert".into());
    }
    let url = format!("{base_url}/export");
    let res = client
        .post(&url)
        .header("User-Agent", user_agent)
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(15))
        .json(&json!({ "install_id": install_id }))
        .send()
        .map_err(|e| format!("send: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("status: {}", res.status()));
    }
    res.json().map_err(|e| format!("parse: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::events::UpdateStage;
    use std::time::UNIX_EPOCH;

    fn ctx_with_locale(locale: Option<&str>) -> TelemetryContext {
        TelemetryContext {
            app_version: "1.3.0".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            os_version: "Windows 11 22631".into(),
            locale: locale.map(str::to_string),
            surface: "desktop".into(),
        }
    }

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn event_to_json_ping_has_only_invariants() {
        let ctx = ctx_with_locale(Some("fr-FR"));
        let v = event_to_json(&Event::Ping { dropped_events: 0 }, &ctx, at(1_785_846_896));
        assert_eq!(v["name"], "ping");
        assert_eq!(v["app_version"], "1.3.0");
        assert_eq!(v["os"], "windows");
        assert_eq!(v["arch"], "x86_64");
        assert_eq!(v["os_version"], "Windows 11 22631");
        assert_eq!(v["surface"], "desktop");
        assert_eq!(v["locale"], "fr-FR");
        assert_eq!(v["client_ts"], "2026-08-04T12:34:56Z");
        assert!(v.get("duration_ms").is_none());
        assert!(v.get("provider").is_none());
        assert!(v.get("dropped_events").is_none());
    }

    #[test]
    fn event_to_json_ping_reports_dropped_events_when_any() {
        let ctx = ctx_with_locale(None);
        let v = event_to_json(&Event::Ping { dropped_events: 12 }, &ctx, at(0));
        assert_eq!(v["dropped_events"], 12);
    }

    #[test]
    fn event_to_json_never_lets_a_message_through_a_code_field() {
        let ctx = ctx_with_locale(None);
        let ev = Event::OperationFailed {
            operation: "thread_create".into(),
            error_code: r"C:\Users\alice\project missing".to_string(),
        };
        let v = event_to_json(&ev, &ctx, at(0));
        assert_eq!(v["operation"], "thread_create");
        assert_eq!(v["error_code"], "other");
    }

    #[test]
    fn event_to_json_thread_spawned_uses_closed_vocabularies() {
        let ctx = ctx_with_locale(None);
        let v = event_to_json(
            &Event::ThreadSpawned {
                kind: "agent".into(),
                provider: "claude".into(),
            },
            &ctx,
            at(0),
        );
        assert_eq!(v["name"], "thread_spawned");
        assert_eq!(v["kind"], "agent");
        assert_eq!(v["provider"], "claude");
        assert!(v.get("cmd").is_none());
        assert!(v.get("label").is_none());

        let v = event_to_json(
            &Event::ThreadSpawned {
                kind: "agent".into(),
                provider: "MyPrivateCli".into(),
            },
            &ctx,
            at(0),
        );
        assert_eq!(v["provider"], "other");
    }

    #[test]
    fn event_to_json_update_sanitizes_the_remote_version() {
        let ctx = ctx_with_locale(None);
        let v = event_to_json(
            &Event::Update {
                stage: UpdateStage::Available,
                target_version: Some("1.4.2".into()),
                error_code: None,
            },
            &ctx,
            at(0),
        );
        assert_eq!(v["name"], "update_available");
        assert_eq!(v["target_version"], "1.4.2");

        let v = event_to_json(
            &Event::Update {
                stage: UpdateStage::Failed,
                target_version: Some("1.4.2 <script>alert(1)</script>".into()),
                error_code: Some("download failed".into()),
            },
            &ctx,
            at(0),
        );
        assert_eq!(v["name"], "update_failed");
        assert_eq!(v["target_version"], "1.4.2scriptalert1script");
        assert_eq!(v["error_code"], "download_failed");
    }

    #[test]
    fn event_to_json_settings_snapshot_is_all_low_cardinality_codes() {
        let ctx = ctx_with_locale(None);
        let v = event_to_json(
            &Event::SettingsSnapshot {
                ui_language: "fr".into(),
                theme: "acrylic-black".into(),
                thread_worktrees: true,
                animations: "system".into(),
                mcp_yolo: false,
                idle_autoclose: true,
                orchestrator: false,
                voice: true,
            },
            &ctx,
            at(0),
        );
        assert_eq!(v["name"], "settings_snapshot");
        assert_eq!(v["ui_language"], "fr");
        assert_eq!(v["theme"], "acrylic_black");
        assert_eq!(v["thread_worktrees"], true);
        assert_eq!(v["animations"], "system");
        assert_eq!(v["mcp_yolo"], false);
        assert_eq!(v["idle_autoclose"], true);
        assert_eq!(v["orchestrator"], false);
        assert_eq!(v["voice"], true);
        assert!(v.get("voice_name").is_none());
    }

    #[test]
    fn event_to_json_omits_locale_when_none() {
        let ctx = ctx_with_locale(None);
        let v = event_to_json(&Event::Ping { dropped_events: 0 }, &ctx, at(0));
        assert!(v.get("locale").is_none());
    }

    #[test]
    fn user_agent_format() {
        assert_eq!(user_agent("1.3.0"), "Boite/1.3.0 (telemetry)");
    }

    #[test]
    fn track_payload_uses_mode_specific_identifier_field() {
        let events = vec![json!({ "name": "ping" })];
        let mode_a = serde_json::to_value(TrackPayload {
            mode: Mode::A.as_str(),
            install_id: None,
            anonymous_id: Some("797f20fe-94de-4e89-98a2-ae3a3273ad1e"),
            events: events.clone(),
        })
        .unwrap();
        assert!(mode_a.get("install_id").is_none());
        assert_eq!(
            mode_a["anonymous_id"],
            "797f20fe-94de-4e89-98a2-ae3a3273ad1e"
        );

        let mode_b = serde_json::to_value(TrackPayload {
            mode: Mode::B.as_str(),
            install_id: Some("550e8400-e29b-41d4-a716-446655440000"),
            anonymous_id: None,
            events,
        })
        .unwrap();
        assert!(mode_b.get("anonymous_id").is_none());
        assert_eq!(mode_b["install_id"], "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn consent_choice_wire_values_are_stable() {
        assert_eq!(ConsentChoice::Refused.as_str(), "refused");
        assert_eq!(ConsentChoice::Basic.as_str(), "basic");
        assert_eq!(ConsentChoice::Enhanced.as_str(), "enhanced");
    }

    #[test]
    fn consent_payload_contains_no_identifier() {
        let payload = serde_json::to_value(ConsentPayload {
            choice: ConsentChoice::Refused.as_str(),
            app_version: "1.3.0",
        })
        .unwrap();
        assert_eq!(
            payload,
            json!({ "choice": "refused", "app_version": "1.3.0" })
        );
        assert!(payload.get("anonymous_id").is_none());
        assert!(payload.get("install_id").is_none());
    }

    #[test]
    fn telemetry_url_fallback_does_not_leak_private_infrastructure() {
        assert!(!TELEMETRY_URL_FALLBACK.contains("mtsu"));
        assert!(TELEMETRY_URL_FALLBACK.ends_with(".invalid"));
    }

    #[test]
    fn inert_placeholder_is_detected() {
        assert!(is_inert(TELEMETRY_URL_FALLBACK));
        assert!(is_inert("https://telemetry.invalid/track"));
        assert!(is_inert(""));
        assert!(!is_inert("https://boite-telemetry.example.workers.dev"));
    }

    #[test]
    fn inert_export_fails_instead_of_lying() {
        let http = reqwest::blocking::Client::new();
        let err = export(&http, TELEMETRY_URL_FALLBACK, "Boite/test", "install-id").unwrap_err();
        assert_eq!(err, "telemetry_inert");
    }

    #[test]
    fn inert_forget_fails_instead_of_lying() {
        let http = reqwest::blocking::Client::new();
        let err = forget(&http, TELEMETRY_URL_FALLBACK, "Boite/test", "install-id").unwrap_err();
        assert_eq!(err, "telemetry_inert");
    }
}
