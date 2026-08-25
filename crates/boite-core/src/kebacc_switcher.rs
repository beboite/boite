//! Asking `kebacc` what it holds, and telling it to flip.
//!
//! That binary is [kebab1337420/kebacc-switch](https://github.com/kebab1337420/kebacc-switch).
//! Boite does not snapshot credentials. It runs the published CLI and returns a
//! normalised document: whatever providers and usage windows the CLI printed,
//! not a hard-coded pair of names.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const BIN: &str = "kebacc";

/// The CLI was called `kebacc-switch` until its 1.0.0, and machines that have
/// not updated still carry that name. Newest first.
const NAMES: [&str; 2] = ["kebacc", "kebacc-switch"];

fn tools_dir_binary(name: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let exe = home
        .join(".claude-tools")
        .join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    exe.is_file().then_some(exe)
}

/// On Windows the installer puts the binary in `~/.claude-tools` and reaches it
/// from a shell profile function, so PATH alone finds nothing.
fn resolve() -> Option<PathBuf> {
    NAMES
        .iter()
        .find_map(|name| which::which(name).ok().or_else(|| tools_dir_binary(name)))
}

fn tool() -> Result<Command, String> {
    let path = resolve().ok_or_else(|| format!("{BIN} is not on this machine"))?;
    let mut cmd = Command::new(path);
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    Ok(cmd)
}

fn fail(out: &Output) -> String {
    let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if msg.is_empty() {
        format!("{BIN} exited with {}", out.status)
    } else {
        msg
    }
}

fn run(args: &[&str]) -> Result<Output, String> {
    tool()?
        .args(args)
        .output()
        .map_err(|e| format!("{BIN} could not be started: {e}"))
}

fn stdout_text(out: &Output) -> Result<String, String> {
    if out.stdout.len() > MAX_OUTPUT {
        return Err(format!(
            "{BIN} printed more than this can be expected to parse"
        ));
    }
    String::from_utf8(out.stdout.clone()).map_err(|_| format!("{BIN} printed invalid UTF-8"))
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for x in chars.by_ref() {
                    if x.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn looks_json(s: &str) -> bool {
    s.trim_start().starts_with('{')
}

fn provider_id(label: &str) -> String {
    label
        .split_whitespace()
        .next()
        .unwrap_or(label)
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn split_header(line: &str) -> Option<(&str, &str)> {
    // A pool with no numbers read yet prints them as a dash, so an account row
    // carries the same separator a header does. The email is what tells them
    // apart: a header names a store, never an account.
    if line.contains('@') {
        return None;
    }
    for sep in [" — ", " – ", " - "] {
        if let Some(i) = line.find(sep) {
            return Some((line[..i].trim(), line[i + sep.len()..].trim()));
        }
    }
    None
}

fn windows_from_usage(usage: &Value) -> Vec<Value> {
    let Some(obj) = usage.as_object() else {
        return Vec::new();
    };
    obj.iter()
        .filter_map(|(key, val)| {
            let inner = val.as_object()?;
            let reset = inner
                .get("resets_at")
                .or_else(|| inner.get("reset"))
                .cloned()
                .unwrap_or(Value::Null);
            Some(json!({
                "label": key.replace('_', " "),
                "used_percent": inner.get("used_percent").cloned().unwrap_or(Value::Null),
                "remaining_percent": inner.get("remaining_percent").cloned().unwrap_or(Value::Null),
                "reset": reset,
            }))
        })
        .collect()
}

fn windows_from_account(account: &Value) -> Vec<Value> {
    if let Some(windows) = account.get("windows").and_then(|v| v.as_array()) {
        return windows.clone();
    }
    account
        .get("usage")
        .map(windows_from_usage)
        .unwrap_or_default()
}

fn normalize_account(account: &Value) -> Value {
    let email = account
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let active = account
        .get("active")
        .or_else(|| account.get("is_active"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    json!({
        "email": email,
        "active": active,
        "windows": windows_from_account(account),
    })
}

fn normalize_provider(provider: &Value) -> Value {
    let id = provider
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let label = provider
        .get("label")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(id);
    let accounts = provider
        .get("accounts")
        .and_then(|v| v.as_array())
        .map(|rows| rows.iter().map(normalize_account).collect::<Vec<_>>())
        .unwrap_or_default();
    json!({
        "provider": id,
        "label": label,
        "accounts": accounts,
    })
}

/// Turn whatever the CLI printed into `{ providers: [...] }` with generic windows.
pub fn normalize_list(raw: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(raw.trim())
        .map_err(|e| format!("{BIN} printed JSON this could not read: {e}"))?;
    let providers = value
        .get("providers")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("{BIN} JSON had no providers"))?;
    Ok(json!({
        "providers": providers.iter().map(normalize_provider).collect::<Vec<_>>(),
    })
    .to_string())
}

fn parse_window_chunk(chunk: &str) -> Option<Value> {
    let chunk = chunk.trim();
    if chunk.is_empty() {
        return None;
    }
    let mut parts = chunk.splitn(2, '%');
    let head = parts.next()?.trim();
    let tail = parts.next().unwrap_or("").trim();
    let (label, percent) = head.rsplit_once(char::is_whitespace)?;
    let used: f64 = percent.trim().parse().ok()?;
    let reset = tail
        .strip_prefix("resets in")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);
    Some(json!({
        "label": label.trim(),
        "used_percent": used,
        "remaining_percent": Value::Null,
        "reset": reset,
    }))
}

fn parse_account_line(line: &str) -> Option<Value> {
    let trimmed = line.trim();
    let active = trimmed.starts_with('*');
    let rest = trimmed.trim_start_matches('*').trim();
    let at = rest.find('@')?;
    let mut email_end = at;
    for (i, c) in rest[at..].char_indices() {
        if c.is_whitespace() {
            email_end = at + i;
            break;
        }
        email_end = at + i + c.len_utf8();
    }
    let email = rest[..email_end].trim();
    if !email.contains('@') {
        return None;
    }
    let usage = rest[email_end..].trim();
    let windows: Vec<Value> = usage.split('|').filter_map(parse_window_chunk).collect();
    Some(json!({
        "email": email,
        "active": active,
        "windows": windows,
    }))
}

fn skip_noise(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('(') || t.starts_with("numbers read")
}

/// Text `list -Countdown` when the CLI has no `-Json`.
pub fn parse_text_list(raw: &str) -> String {
    let text = strip_ansi(raw);
    let mut providers: Vec<Value> = Vec::new();
    let mut current_id = String::new();
    let mut current_label = String::new();
    let mut accounts: Vec<Value> = Vec::new();

    fn flush(providers: &mut Vec<Value>, id: &str, label: &str, accounts: &[Value]) {
        if id.is_empty() {
            return;
        }
        providers.push(json!({
            "provider": id,
            "label": label,
            "accounts": accounts,
        }));
    }

    for line in text.lines() {
        if let Some((label, _path)) = split_header(line) {
            flush(&mut providers, &current_id, &current_label, &accounts);
            current_label = label.to_string();
            current_id = provider_id(label);
            accounts = Vec::new();
            continue;
        }
        if skip_noise(line) {
            continue;
        }
        if current_id.is_empty() {
            continue;
        }
        if let Some(account) = parse_account_line(line) {
            accounts.push(account);
        }
    }
    flush(&mut providers, &current_id, &current_label, &accounts);
    json!({ "providers": providers }).to_string()
}

fn list_document(provider: &str) -> Result<String, String> {
    let json_out = run(&["list", "-Provider", provider, "-Json"])?;
    if let Ok(text) = stdout_text(&json_out) {
        let stripped = strip_ansi(&text);
        // kebacc 2.x prints one object per pool, on its own line, with no
        // `providers` key and no per-window reset. Text is the richer of the
        // two there, so JSON this cannot read falls through instead of failing.
        if looks_json(&stripped) {
            if let Ok(doc) = normalize_list(&stripped) {
                return Ok(doc);
            }
        }
    }
    let text_out = run(&["list", "-Provider", provider, "-Countdown"])?;
    if !text_out.status.success() && !json_out.status.success() {
        let err = fail(&text_out);
        if err.is_empty() {
            return Err(fail(&json_out));
        }
        return Err(err);
    }
    let text = stdout_text(&text_out).or_else(|_| stdout_text(&json_out))?;
    Ok(parse_text_list(&text))
}

fn run_then_list(args: &[&str], list_provider: &str) -> Result<String, String> {
    let with_json: Vec<&str> = args.iter().copied().chain(["-Json"]).collect();
    let out = run(&with_json)?;
    if !out.status.success() {
        let retry = run(args)?;
        if !retry.status.success() {
            return Err(fail(&retry));
        }
    }
    list_document(list_provider)
}

/// `kebacc list -Provider <p>` as a normalised JSON string.
pub fn list_blocking(provider: Option<&str>) -> Result<String, String> {
    let p = provider.filter(|s| !s.is_empty()).unwrap_or("all");
    list_document(p)
}

/// `kebacc add -Provider <p>`.
pub fn add_blocking(provider: &str) -> Result<String, String> {
    if provider.is_empty() || provider == "all" {
        return Err("add needs a provider".into());
    }
    run_then_list(&["add", "-Provider", provider], provider)
}

/// `kebacc switch -Provider <p> -Email <email> -Yes`.
pub fn switch_blocking(provider: &str, email: &str) -> Result<String, String> {
    if provider.is_empty() || provider == "all" {
        return Err("switch needs a provider".into());
    }
    if email.is_empty() {
        return Err("switch needs an email".into());
    }
    run_then_list(
        &["switch", "-Provider", provider, "-Email", email, "-Yes"],
        provider,
    )
}

/// What `--version` prints, or `None` when the binary is not here.
pub fn version_blocking() -> Option<String> {
    let mut cmd = tool().ok()?;
    let out = cmd.arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let version = text
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .trim()
        .to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Whether the binary is on PATH or in `~/.claude-tools`.
pub fn installed_blocking() -> bool {
    resolve().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = "\
Claude Code — C:\\Users\\mtsu\\.kebacc-switch-accounts
* nefreex@gmail.com               5h  0%  |  7d  0%
  ziziperso@bagarrevoisinmail.com 5h  0%  |  7d 94% resets in 9h13m
  numbers read 1d 20h ago

Codex — C:\\Users\\mtsu\\.kebacc-switch-codex-accounts
  (no store directory)
";

    const JSON: &str = r#"{"providers":[{"provider":"claude","accounts":[{"email":"nefreex@gmail.com","active":true,"usable":true,"usage":{"five_hour":{"used_percent":0.0,"remaining_percent":100.0,"resets_at":null},"seven_day":{"used_percent":0.0,"remaining_percent":100.0,"resets_at":null}},"trust":"trusted","sealed":true},{"email":"ziziperso@bagarrevoisinmail.com","active":false,"usable":true,"usage":{"five_hour":{"used_percent":0.0,"remaining_percent":100.0,"resets_at":null},"seven_day":{"used_percent":94.0,"remaining_percent":6.0,"resets_at":"2026-08-21T02:00:00Z"}},"trust":"trusted","sealed":true}]},{"provider":"codex","accounts":[]}]}"#;

    #[test]
    fn an_empty_email_is_refused_before_the_binary_runs() {
        let err = switch_blocking("claude", "").expect_err("empty email");
        assert!(err.contains("email"));
    }

    #[test]
    fn add_refuses_all() {
        let err = add_blocking("all").expect_err("all");
        assert!(err.contains("provider"));
    }

    #[test]
    fn text_list_keeps_every_window_the_cli_printed() {
        let doc: Value = serde_json::from_str(&parse_text_list(TEXT)).unwrap();
        let providers = doc["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0]["provider"], "claude");
        assert_eq!(providers[0]["label"], "Claude Code");
        let accounts = providers[0]["accounts"].as_array().unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0]["email"], "nefreex@gmail.com");
        assert_eq!(accounts[0]["active"], true);
        assert_eq!(accounts[0]["windows"][0]["label"], "5h");
        assert_eq!(accounts[0]["windows"][0]["used_percent"], 0.0);
        assert_eq!(accounts[1]["windows"][1]["label"], "7d");
        assert_eq!(accounts[1]["windows"][1]["used_percent"], 94.0);
        assert_eq!(accounts[1]["windows"][1]["reset"], "9h13m");
        assert_eq!(providers[1]["provider"], "codex");
        assert!(providers[1]["accounts"].as_array().unwrap().is_empty());
    }

    #[test]
    fn json_usage_keys_become_windows_without_renaming_them() {
        let raw = normalize_list(JSON).unwrap();
        let doc: Value = serde_json::from_str(&raw).unwrap();
        let windows = doc["providers"][0]["accounts"][1]["windows"]
            .as_array()
            .unwrap();
        let labels: Vec<&str> = windows
            .iter()
            .map(|w| w["label"].as_str().unwrap())
            .collect();
        assert!(labels.contains(&"five hour"));
        assert!(labels.contains(&"seven day"));
        let seven = windows.iter().find(|w| w["label"] == "seven day").unwrap();
        assert_eq!(seven["used_percent"], 94.0);
        assert_eq!(seven["remaining_percent"], 6.0);
        assert_eq!(doc["providers"][1]["accounts"].as_array().unwrap().len(), 0);
    }

    const POOL_JSON: &str = r#"{"pool":"Claude Code","store":"/home/a/.kebacc-switch-accounts","caps":{"fiveHour":98.0,"sevenDay":98.0},"accounts":[{"email":"you@example.com","live":true,"fiveHour":0.0,"sevenDay":28.0,"usable":true,"readyAt":null}]}"#;

    const NO_NUMBERS_YET: &str = "\
Antigravity — /home/a/.kebacc-switch-antigravity-accounts
* you@example.com                 5h —  |  7d —
";

    #[test]
    fn a_pool_document_with_no_providers_is_left_to_the_text_path() {
        let err = normalize_list(POOL_JSON).expect_err("kebacc 2.x prints one pool per line");
        assert!(err.contains("providers"));
    }

    #[test]
    fn a_pool_whose_numbers_were_never_read_still_lists_its_account() {
        let doc: Value = serde_json::from_str(&parse_text_list(NO_NUMBERS_YET)).unwrap();
        let accounts = doc["providers"][0]["accounts"].as_array().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["email"], "you@example.com");
        assert_eq!(accounts[0]["active"], true);
        assert!(accounts[0]["windows"].as_array().unwrap().is_empty());
    }

    #[test]
    fn provider_id_is_the_first_word() {
        assert_eq!(provider_id("Claude Code"), "claude");
        assert_eq!(provider_id("Codex"), "codex");
        assert_eq!(provider_id("Antigravity CLI"), "antigravity");
    }
}
