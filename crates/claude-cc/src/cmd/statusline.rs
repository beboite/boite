//! The Claude Code status line: which account is in use, how much of its quota
//! is gone, and how many saved accounts still have room.
//!
//! Claude Code hands this process a JSON payload on stdin and prints whatever
//! single line comes back. It runs on every repaint, so it never asks the
//! network: the live window comes from the payload, and everything about the
//! other accounts comes from the cache the switcher already wrote.

use crate::jsonio;
use crate::provider::{self, ProviderId};
use crate::usage::{self, Usage};
use serde_json::Value;
use std::io::Read;

pub fn run() -> i32 {
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    // Run by hand, or handed something unexpected: the pool still has answers.
    let payload: Value = serde_json::from_str(&stdin).unwrap_or(Value::Null);
    let line = build(&payload);
    if !line.is_empty() {
        print!("{line}");
    }
    0
}

/// A terminal that cannot draw the separator gets one it can.
fn separator() -> &'static str {
    let ascii = match std::env::var("CLAUDE_CC_STATUSLINE_ASCII") {
        Ok(flag) if !flag.is_empty() => {
            !matches!(flag.to_lowercase().as_str(), "0" | "false" | "off" | "no")
        }
        _ => ["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .find_map(|name| std::env::var(name).ok())
            .filter(|locale| !locale.is_empty())
            .is_some_and(|locale| !locale.to_lowercase().contains("utf")),
    };
    if ascii {
        " | "
    } else {
        " · "
    }
}

struct Account {
    email: Option<String>,
    usage: Option<Usage>,
}

fn build(payload: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    let claude = provider::spec(ProviderId::Claude);
    let current = live_email();
    if let Some(current) = &current {
        parts.push(current.split('@').next().unwrap_or(current).to_string());
    }

    // The live window beats the cache for the account in use: the payload was
    // written by the session this line is being drawn for.
    let live = usage::from_cache(payload.get("rate_limits"));
    let accounts = pool(&claude.store);
    let mine = match (&accounts, &current) {
        (Some(accounts), Some(current)) => accounts
            .iter()
            .find(|a| a.email.as_deref() == Some(current.as_str())),
        _ => None,
    };
    let shown = live.or_else(|| {
        mine.and_then(|a| a.usage.as_ref()).map(|u| Usage {
            five_hour: u.five_hour.clone(),
            seven_day: u.seven_day.clone(),
        })
    });

    if let Some(usage) = &shown {
        parts.push(format!(
            "5h {} / 7d {}",
            usage::pct_text(usage.pct("five_hour")).trim(),
            usage::pct_text(usage.pct("seven_day")).trim()
        ));
        if !usage.usable() {
            parts.push(match usage.ready_at() {
                Some(at) => format!("back in {}", usage::wait_text(at)),
                None => "capped".to_string(),
            });
        }
    }

    if let Some(accounts) = &accounts {
        if accounts.len() > 1 {
            let free = accounts
                .iter()
                .filter(|a| a.email != current && a.usage.as_ref().is_none_or(Usage::usable))
                .count();
            parts.push(format!("{free} free"));
        }
    }

    // Codex has a pool of its own, switched from the same place, so what is left
    // there is worth one word here.
    let codex = provider::spec(ProviderId::Codex);
    if let Some(accounts) = pool(&codex.store) {
        if !accounts.is_empty() {
            let free = accounts
                .iter()
                .filter(|a| a.usage.as_ref().is_none_or(Usage::usable))
                .count();
            parts.push(format!("codex {free} free"));
        }
    }

    // Last, because it is about the next session rather than this one. Silent
    // when nothing arms the switch: a line that says "off" on every machine that
    // never wanted it is noise.
    if let Some(scope) = auto_scope() {
        parts.push(auto_label(&scope));
    }

    parts.join(separator())
}

/// The account the CLI is logged in as, lowercased.
fn live_email() -> Option<String> {
    let config = jsonio::read(&provider::home().join(".claude.json"))?;
    let account = config.get("oauthAccount")?;
    jsonio::str_of(account, "emailAddress").map(|e| e.to_lowercase())
}

/// One pool, as accounts. A missing pool is not an empty one.
fn pool(store: &std::path::Path) -> Option<Vec<Account>> {
    let dir = std::fs::read_dir(store).ok()?;
    let mut out = Vec::new();
    for file in dir.filter_map(|e| e.ok()).map(|e| e.path()) {
        let name = file.file_name()?.to_string_lossy().to_string();
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let Some(snapshot) = jsonio::read(&file) else {
            continue;
        };
        out.push(Account {
            email: jsonio::str_of(&snapshot, "email").map(|e| e.to_lowercase()),
            usage: usage::from_cache(snapshot.get("usageCache")),
        });
    }
    Some(out)
}

/// Which pools a SessionStart hook keeps switched, as a word, or none when
/// nothing does. `auto` only ever runs when something calls it, so the hook that
/// calls it is the whole answer to "is this armed, and for what".
fn auto_scope() -> Option<String> {
    let dir = provider::claude_config_dir();
    let mut found: Vec<String> = Vec::new();
    for name in ["settings.json", "settings.local.json"] {
        let Some(settings) = jsonio::read(&dir.join(name)) else {
            continue;
        };
        for command in super::doctor::auto_hooks(&settings) {
            let scope = super::doctor::hook_scope(&command).unwrap_or_else(|| "claude".into());
            if !found.contains(&scope) {
                found.push(scope);
            }
        }
    }
    if found.is_empty() {
        return None;
    }
    // One hook over everything beats naming the pools one by one; two separate
    // hooks read as what they are.
    if found.iter().any(|s| s == "all") {
        return Some("all".into());
    }
    found.sort();
    Some(found.join("+"))
}

/// One colour per pool, so two hooks side by side stay tellable apart at a
/// glance. The word "auto" stays as it is: it is the same in every case.
fn auto_label(scope: &str) -> String {
    if scope == "all" {
        return format!("auto {}", tint("all", "32"));
    }
    let named: Vec<String> = scope
        .split('+')
        .map(|name| match name {
            "claude" => tint(name, "38;5;208"),
            "codex" => tint(name, "38;5;141"),
            other => other.to_string(),
        })
        .collect();
    format!("auto {}", named.join("+"))
}

fn tint(text: &str, code: &str) -> String {
    if std::env::var_os("NO_COLOR").is_some() {
        return text.to_string();
    }
    format!("\x1b[{code}m{text}\x1b[0m")
}
