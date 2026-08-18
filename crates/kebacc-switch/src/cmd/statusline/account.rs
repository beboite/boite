use super::{bold, cyan, dim, green, off, orange, red, violet, yellow};
use crate::jsonio;
use crate::pool;
use crate::provider::{self, ProviderId};
use crate::usage;
use chrono::Utc;
use serde_json::Value;
use std::sync::OnceLock;

const POOLS: [&str; 2] = ["claude", "codex"];

pub struct Glyphs {
    pub arrow: &'static str,
    pub fresh: &'static str,
    pub step: &'static str,
    pub wait: &'static str,
    pub cut: &'static str,
    pub sep: &'static str,
    pub group: &'static str,
}

const UNICODE: Glyphs = Glyphs {
    arrow: "⇄",
    fresh: "↑",
    step: "→",
    wait: "⏳",
    cut: "…",
    sep: " · ",
    group: "  │  ",
};

const ASCII: Glyphs = Glyphs {
    arrow: "<>",
    fresh: "^",
    step: "->",
    wait: "~",
    cut: "..",
    sep: " | ",
    group: "  |  ",
};

pub fn glyphs() -> &'static Glyphs {
    if ascii_only() {
        &ASCII
    } else {
        &UNICODE
    }
}

fn ascii_only() -> bool {
    if let Some(flag) = std::env::var("KEBACC_SWITCH_STATUSLINE_ASCII")
        .ok()
        .filter(|f| !f.is_empty())
    {
        return !off(&flag);
    }
    if let Some(pref) = prefs().get("ascii").and_then(Value::as_bool) {
        return pref;
    }
    if std::env::var("TERM").is_ok_and(|term| term == "dumb") {
        return true;
    }
    ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .filter(|locale| !locale.is_empty())
        .is_some_and(|locale| !locale.to_lowercase().contains("utf"))
}

fn prefs() -> &'static Value {
    static PREFS: OnceLock<Value> = OnceLock::new();
    PREFS.get_or_init(|| {
        jsonio::read(&store().join(".statusline.json"))
            .filter(Value::is_object)
            .unwrap_or(Value::Null)
    })
}

fn store() -> std::path::PathBuf {
    provider::spec(ProviderId::Claude).store
}

fn budget() -> Option<usize> {
    let columns = ["KEBACC_SWITCH_STATUSLINE_WIDTH", "COLUMNS"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .or_else(|| {
            prefs()
                .get("width")
                .and_then(Value::as_u64)
                .map(|w| w as usize)
        })
        .filter(|columns| *columns > 0)?;
    Some(std::cmp::max(16, columns * 2 / 5))
}

fn name_rooms() -> (usize, usize) {
    match budget() {
        None => (14, 10),
        Some(b) if b >= 34 => (14, 10),
        Some(b) if b >= 26 => (10, 6),
        Some(b) if b >= 20 => (8, 0),
        Some(_) => (0, 0),
    }
}

fn char_width(c: char) -> usize {
    let cp = c as u32;
    if (0x300..=0x36f).contains(&cp) {
        return 0;
    }
    let wide = (0x1100..=0x115f).contains(&cp)
        || (0x2e80..=0xa4cf).contains(&cp)
        || (0xac00..=0xd7a3).contains(&cp)
        || (0xf900..=0xfaff).contains(&cp)
        || (0xfe30..=0xfe6f).contains(&cp)
        || (0xff00..=0xff60).contains(&cp)
        || (0xffe0..=0xffe6).contains(&cp)
        || (0x1f300..=0x1f9ff).contains(&cp);
    if wide {
        2
    } else {
        1
    }
}

pub fn display_width(text: &str) -> usize {
    text.chars().map(char_width).sum()
}

pub fn clip(text: &str, max: usize, mark: &str) -> String {
    if display_width(text) <= max {
        return text.to_string();
    }
    let mark_width = display_width(mark);
    if mark_width >= max {
        return mark.chars().take(max).collect();
    }
    let room = max - mark_width;
    let mut out = String::new();
    let mut width = 0;
    for c in text.chars() {
        let w = char_width(c);
        if width + w > room {
            break;
        }
        out.push(c);
        width += w;
    }
    out + mark
}

fn short_local(email: Option<&str>, max: usize) -> Option<String> {
    let email = email?;
    if max == 0 {
        return None;
    }
    Some(clip(email.split('@').next()?, max, glyphs().cut))
}

pub fn current_email() -> Option<String> {
    let config = jsonio::read(&provider::spec(ProviderId::Claude).config_file())?;
    let account = config.get("oauthAccount")?;
    jsonio::str_of(account, "emailAddress").map(|email| email.to_lowercase())
}

struct Seats {
    free: usize,
    unknown: usize,
    total: usize,
    others: usize,
    wait_ms: Option<i64>,
    wait_email: Option<String>,
    wait_unknown: bool,
}

fn seats(payload: &Value) -> Option<Seats> {
    let accounts = pool::plain_snapshots(&store())?;
    let current = current_email();
    let live = payload.get("rate_limits").filter(|v| !v.is_null());
    let now = Utc::now();

    let mut out = Seats {
        free: 0,
        unknown: 0,
        total: 0,
        others: 0,
        wait_ms: None,
        wait_email: None,
        wait_unknown: false,
    };
    let mut soonest: Option<chrono::DateTime<Utc>> = None;

    for (_, snapshot) in &accounts {
        if snapshot.is_null() {
            continue;
        }
        let email = jsonio::str_of(snapshot, "email").map(|e| e.to_lowercase());
        let mine = matches!((&email, &current), (Some(a), Some(b)) if a == b);
        out.total += 1;
        if !mine {
            out.others += 1;
        }

        let cache = match (mine, live) {
            (true, Some(live)) => usage::from_cache(Some(live)),
            _ => usage::from_cache(snapshot.get("usageCache")),
        };
        let Some(cache) = cache.filter(usage::Usage::known) else {
            out.unknown += 1;
            continue;
        };

        let mut back: Option<chrono::DateTime<Utc>> = None;
        let mut timeless = false;
        let mut full = false;
        for (name, cap) in usage::caps() {
            let Some(window) = cache.window(name).filter(|w| w.blocking(cap)) else {
                continue;
            };
            full = true;
            match window.resets() {
                None => {
                    timeless = true;
                    break;
                }
                Some(at) if back.is_none_or(|seen| at > seen) => back = Some(at),
                Some(_) => {}
            }
        }

        if !full {
            out.free += 1;
            continue;
        }
        if mine {
            continue;
        }
        if timeless {
            out.wait_unknown = true;
            continue;
        }
        if let Some(at) = back {
            if soonest.is_none_or(|seen| at < seen) {
                soonest = Some(at);
                out.wait_email = email.clone();
            }
        }
    }

    if let Some(at) = soonest {
        out.wait_ms = Some((at - now).num_milliseconds());
        out.wait_unknown = false;
    }
    Some(out)
}

fn human_wait(ms: i64) -> String {
    let minutes = std::cmp::max(1, (ms as f64 / 60000.0).round() as i64);
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h{:02}", minutes % 60);
    }
    format!("{}j{:02}", hours / 24, hours % 24)
}

fn auto_scope() -> Option<String> {
    let dir = provider::claude_config_dir();
    let mut found: Vec<String> = Vec::new();
    for name in ["settings.json", "settings.local.json"] {
        let Some(settings) = jsonio::read(&dir.join(name)) else {
            continue;
        };
        for command in crate::cmd::doctor::auto_hooks(&settings) {
            let scope = crate::cmd::doctor::hook_scope(&command).unwrap_or_else(|| "claude".into());
            if !found.contains(&scope) {
                found.push(scope);
            }
        }
    }
    if found.is_empty() {
        return None;
    }
    if found.iter().any(|s| s == "all") || POOLS.iter().all(|p| found.iter().any(|s| s == p)) {
        return Some("all".into());
    }
    found.sort();
    Some(found.join("+"))
}

fn auto_label(scope: Option<&str>) -> String {
    let Some(scope) = scope else {
        return red("auto off");
    };
    if scope == "all" {
        return green("auto all");
    }
    let tint = |pool: &str| -> fn(&str) -> String {
        match pool {
            "claude" => orange,
            "codex" => violet,
            _ => dim,
        }
    };
    let pools: Vec<&str> = scope.split('+').collect();
    let named: Vec<String> = pools.iter().map(|pool| tint(pool)(pool)).collect();
    let paint = if pools.len() == 1 {
        tint(pools[0])
    } else {
        dim
    };
    format!("{} {}", paint("auto"), named.join(&dim("+")))
}

pub fn update_note() -> Option<String> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let (from, to, _) = crate::cmd::update::last(&dir)?;
    let g = glyphs();
    Some(green(&format!("{}{from}{}{to}", g.fresh, g.step)))
}

pub fn segments(payload: &Value) -> Vec<String> {
    if std::env::var("KEBACC_SWITCH_STATUSLINE").is_ok_and(|flag| off(&flag)) {
        return Vec::new();
    }
    let g = glyphs();
    let (who_room, target_room) = name_rooms();
    let scope = auto_scope();
    let who = short_local(current_email().as_deref(), who_room);
    let mut out: Vec<String> = Vec::new();

    let mark = if scope.is_some() {
        green(g.arrow)
    } else {
        red(g.arrow)
    };
    if let Some(who) = &who {
        out.push(format!("{mark} {}", bold(&cyan(who))));
    }

    let Some(seats) = seats(payload) else {
        out.push(dim(&match who {
            Some(_) => "no pool".to_string(),
            None => format!("{} no pool", g.arrow),
        }));
        return out;
    };
    if seats.others == 0 {
        out.push(dim("solo"));
        out.push(auto_label(scope.as_deref()));
        return out;
    }
    if who.is_none() {
        out.push(mark);
    }

    let paint: fn(&str) -> String = match seats.free {
        0 => red,
        1 => yellow,
        _ => green,
    };
    let mut state = paint(&format!("{}/{} free", seats.free, seats.total));
    if seats.unknown > 0 {
        state.push_str(&dim(&format!(" +{}?", seats.unknown)));
    }
    if let Some(ms) = seats.wait_ms {
        let target = short_local(seats.wait_email.as_deref(), target_room);
        let wait = format!(
            "{}{}{}",
            g.wait,
            human_wait(ms),
            target.map(|t| format!(" {t}")).unwrap_or_default()
        );
        state.push(' ');
        state.push_str(&if seats.free == 0 {
            yellow(&wait)
        } else {
            dim(&wait)
        });
    } else if seats.wait_unknown {
        state.push_str(&format!(" {}", dim(&format!("{}?", g.wait))));
    }
    out.push(state);

    if let Some(codex) = codex_seats() {
        out.push(codex);
    }

    out.push(auto_label(scope.as_deref()));
    out
}

fn codex_seats() -> Option<String> {
    let store = provider::spec(ProviderId::Codex).store;
    let accounts = pool::plain_snapshots(&store)?;
    let mut total = 0usize;
    let mut free = 0usize;
    for (_, snapshot) in &accounts {
        if snapshot.is_null() {
            continue;
        }
        total += 1;
        if usage::from_cache(snapshot.get("usageCache"))
            .filter(usage::Usage::known)
            .is_some_and(|cache| cache.usable())
        {
            free += 1;
        }
    }
    if total == 0 {
        return None;
    }
    Some(violet(&format!("codex {free}/{total} free")))
}
