use crate::jsonio;
use crate::lock;
use crate::pool::Entry;
use crate::provider::Provider;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::path::Path;

pub const FIVE_HOUR_CAP: f64 = 99.0;
pub const SEVEN_DAY_CAP: f64 = 99.8;
const CACHE_SECONDS: i64 = 60;

pub fn caps() -> [(&'static str, f64); 2] {
    [
        (
            "five_hour",
            cap_from_env("CLAUDE_AUTOSWITCH_THRESHOLD", FIVE_HOUR_CAP),
        ),
        (
            "seven_day",
            cap_from_env("CLAUDE_AUTOSWITCH_WEEKLY_THRESHOLD", SEVEN_DAY_CAP),
        ),
    ]
}

fn cap_from_env(name: &str, fallback: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|value| *value > 0.0 && *value <= 100.0)
        .unwrap_or(fallback)
}

pub fn at_cap(pct: f64, cap: f64) -> bool {
    let cap = if pct.fract() == 0.0 { cap.floor() } else { cap };
    pct >= cap
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

pub struct Usage {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
}

#[derive(Clone)]
pub struct Window {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

impl Window {
    pub fn resets(&self) -> Option<DateTime<Utc>> {
        self.resets_at.as_deref().and_then(parse_time)
    }

    pub fn blocking(&self, cap: f64) -> bool {
        if !at_cap(self.utilization, cap) {
            return false;
        }
        self.resets().is_none_or(|at| at > Utc::now())
    }
}

impl Usage {
    pub fn window(&self, name: &str) -> Option<&Window> {
        match name {
            "five_hour" => self.five_hour.as_ref(),
            _ => self.seven_day.as_ref(),
        }
    }

    pub fn pct(&self, name: &str) -> Option<f64> {
        self.window(name).map(|w| w.utilization)
    }

    pub fn usable(&self) -> bool {
        !caps()
            .iter()
            .any(|(name, cap)| self.window(name).is_some_and(|w| w.blocking(*cap)))
    }

    pub fn ready_at(&self) -> Option<DateTime<Utc>> {
        let mut at: Option<DateTime<Utc>> = None;
        for (name, cap) in caps() {
            let Some(window) = self.window(name).filter(|w| w.blocking(cap)) else {
                continue;
            };
            let Some(when) = window.resets() else {
                continue;
            };
            if at.is_none_or(|current| when > current) {
                at = Some(when);
            }
        }
        at
    }

    pub fn as_pair(&self) -> String {
        let five = self.pct("five_hour");
        let seven = self.pct("seven_day");
        if five.is_none() && seven.is_none() {
            return "usage n/a".into();
        }
        format!("5h {} / 7d {} used", pct_text(five), pct_text(seven))
    }
}

pub fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

pub fn pct_text(value: Option<f64>) -> String {
    let text = match value {
        None => "?".to_string(),
        Some(v) if v > 99.0 && v < 100.0 => format!("{v:.1}%"),
        Some(v) => format!("{}%", v.round() as i64),
    };
    format!("{text:>4}")
}

pub fn wait_text(at: DateTime<Utc>) -> String {
    let span = at - Utc::now();
    let seconds = span.num_seconds();
    if seconds <= 0 {
        return "now".into();
    }
    let minutes = (seconds as f64 / 60.0).ceil() as i64;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h{:02}m", minutes % 60);
    }
    format!("{}d{:02}h", hours / 24, hours % 24)
}

fn window_from(value: Option<&Value>) -> Option<Window> {
    let value = value.filter(|v| !v.is_null())?;
    let pct = ["used_percent", "utilization", "used_percentage"]
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_f64))
        .unwrap_or(0.0);
    let resets = match jsonio::str_of(value, "resets_at") {
        Some(at) => Some(at),
        None => value
            .get("resets_in_seconds")
            .and_then(Value::as_f64)
            .map(|secs| {
                (Utc::now() + chrono::Duration::seconds(secs as i64))
                    .to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
            }),
    };
    Some(Window {
        utilization: (pct * 10.0).round() / 10.0,
        resets_at: resets,
    })
}

pub fn access_token(provider: &Provider, creds_raw: Option<&str>) -> Option<String> {
    let creds: Value = serde_json::from_str(creds_raw?).ok()?;
    if provider.is_codex() {
        if let Some(tokens) = creds.get("tokens").filter(|v| !v.is_null()) {
            return jsonio::str_of(tokens, "access_token");
        }
        return jsonio::str_of(&creds, "OPENAI_API_KEY");
    }
    let oauth = creds.get("claudeAiOauth").filter(|v| !v.is_null())?;
    jsonio::str_of(oauth, "accessToken")
}

fn agent() -> ureq::Agent {
    let config =
        ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(8)));
    #[cfg(windows)]
    let config = config.tls_config(
        ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::NativeTls)
            .build(),
    );
    config.build().new_agent()
}

fn get_json(url: &str, headers: &[(&str, &str)]) -> Option<Value> {
    let agent = agent();
    let mut request = agent.get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let mut response = request.call().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.body_mut().read_json::<Value>().ok()
}

pub fn fetch(provider: &Provider, token: Option<&str>) -> Option<Usage> {
    let token = token?;
    if provider.is_codex() {
        if token.starts_with("sk-") {
            return None;
        }
        let raw = get_json(
            "https://chatgpt.com/backend-api/codex/usage",
            &[("Authorization", &format!("Bearer {token}"))],
        )?;
        let limits = raw.get("rate_limits").filter(|v| !v.is_null())?;
        return Some(Usage {
            five_hour: window_from(limits.get("primary")),
            seven_day: window_from(limits.get("secondary")),
        });
    }
    let raw = get_json(
        "https://api.anthropic.com/api/oauth/usage",
        &[
            ("Authorization", &format!("Bearer {token}")),
            ("anthropic-version", "2023-06-01"),
            ("anthropic-beta", "oauth-2025-04-20"),
        ],
    )?;
    Some(Usage {
        five_hour: window_from(raw.get("five_hour")),
        seven_day: window_from(raw.get("seven_day")),
    })
}

pub fn from_cache(cache: Option<&Value>) -> Option<Usage> {
    let cache = cache?;
    Some(Usage {
        five_hour: window_from(cache.get("five_hour")),
        seven_day: window_from(cache.get("seven_day")),
    })
}

fn cache_fresh(cache: Option<&Value>) -> bool {
    let Some(at) = cache.and_then(|c| jsonio::str_of(c, "checkedAt")) else {
        return false;
    };
    let Some(at) = parse_time(&at) else {
        return false;
    };
    (Utc::now() - at).num_seconds() < CACHE_SECONDS
}

fn save_cache(file: &Path, usage: &Usage) {
    let _ = lock::locked(lock::USAGE_CACHE, || {
        let Some(mut snapshot) = jsonio::read(file) else {
            return;
        };
        let mut cache = serde_json::Map::new();
        cache.insert("checkedAt".into(), json!(now_iso()));
        for (name, window) in [
            ("five_hour", &usage.five_hour),
            ("seven_day", &usage.seven_day),
        ] {
            if let Some(window) = window {
                cache.insert(
                    name.into(),
                    json!({ "utilization": window.utilization, "resets_at": window.resets_at }),
                );
            }
        }
        jsonio::map_mut(&mut snapshot).insert("usageCache".into(), Value::Object(cache));
        let _ = jsonio::write(file, &snapshot);
    });
}

pub fn for_entry(provider: &Provider, entry: &Entry, force: bool) -> Option<Usage> {
    if !force && cache_fresh(entry.cache.as_ref()) {
        return from_cache(entry.cache.as_ref());
    }
    let token = access_token(provider, entry.creds.as_deref());
    match fetch(provider, token.as_deref()) {
        Some(usage) => {
            save_cache(&entry.file, &usage);
            Some(usage)
        }
        None => from_cache(entry.cache.as_ref()),
    }
}
