use crate::jsonio;
use crate::live;
use crate::pool;
use crate::provider::Provider;
use crate::term::{say, Color};
use crate::usage;
use chrono::Utc;
use serde_json::Value;

const WINDOWS: [(&str, &str); 2] = [("five_hour", "5h"), ("seven_day", "7d")];

pub fn run(provider: &Provider) -> i32 {
    say(
        &format!("{} — {}", provider.label, provider.store.display()),
        Color::Cyan,
    );

    let Some(accounts) = pool::plain_snapshots(&provider.store) else {
        say("  (no store directory)", Color::Dim);
        return 0;
    };
    if accounts.is_empty() {
        say("  No accounts saved yet.", Color::Yellow);
        return 0;
    }

    let current = live::identity(provider)
        .and_then(|id| jsonio::str_of(&id, "emailAddress"))
        .map(|email| email.to_lowercase());
    let mut oldest: Option<chrono::DateTime<Utc>> = None;

    for (file, snapshot) in &accounts {
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if snapshot.is_null() {
            say(&format!("  {stem}  (unreadable snapshot)"), Color::Yellow);
            continue;
        }
        let email = jsonio::str_of(snapshot, "email").unwrap_or(stem);
        let cache = snapshot.get("usageCache");
        let mark = if current
            .as_deref()
            .is_some_and(|c| c == email.to_lowercase())
        {
            '*'
        } else {
            ' '
        };

        let cells: Vec<String> = WINDOWS
            .iter()
            .map(|(key, label)| cell(cache, key, label))
            .collect();
        say(
            &format!("{mark} {email:<32}{}", cells.join("  |  ")),
            if mark == '*' {
                Color::Green
            } else {
                Color::Plain
            },
        );

        if let Some(at) = cache
            .and_then(|c| jsonio::str_of(c, "checkedAt"))
            .and_then(|at| usage::parse_time(&at))
        {
            if oldest.is_none_or(|current| at < current) {
                oldest = Some(at);
            }
        }
    }

    if let Some(at) = oldest {
        say(
            &format!("  numbers read {} ago", elapsed_text(at)),
            Color::Dim,
        );
    }
    0
}

fn cell(cache: Option<&Value>, key: &str, label: &str) -> String {
    let Some(window) = cache.and_then(|c| c.get(key)).filter(|w| w.is_object()) else {
        return format!("{label} —");
    };
    let pct = match window.get("utilization").and_then(Value::as_f64) {
        Some(value) => format!("{:>3}", value.round() as i64),
        None => "  ?".to_string(),
    };
    let back = match jsonio::str_of(window, "resets_at").and_then(|at| usage::parse_time(&at)) {
        Some(at) if at <= Utc::now() => " window already reset, number is stale".to_string(),
        Some(at) => format!(" resets in {}", wait_text(at)),
        None => String::new(),
    };
    format!("{label}{pct}%{back}")
}

fn wait_text(at: chrono::DateTime<Utc>) -> String {
    span_text((at - Utc::now()).num_milliseconds())
}

fn elapsed_text(at: chrono::DateTime<Utc>) -> String {
    span_text((Utc::now() - at).num_milliseconds())
}

fn span_text(ms: i64) -> String {
    if ms <= 0 {
        return "now".into();
    }
    let minutes = (ms as f64 / 60000.0).round() as i64;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    let rest = minutes % 60;
    if hours < 24 {
        return if rest > 0 {
            format!("{hours}h{rest:02}m")
        } else {
            format!("{hours}h")
        };
    }
    let days = hours / 24;
    let rest = hours % 24;
    if rest > 0 {
        format!("{days}d {rest}h")
    } else {
        format!("{days}d")
    }
}
