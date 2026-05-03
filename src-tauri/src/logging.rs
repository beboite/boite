use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const LOG_FILE_NAME: &str = "app.log";
const PREVIOUS_LOG_FILE_NAME: &str = "app.previous.log";
const MAX_MESSAGE_BYTES: usize = 512;
const MAX_DETAILS_BYTES: usize = 16_384;

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn log_lock() -> &'static Mutex<()> {
    LOG_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub ts_ms: u64,
    pub level: String,
    pub source: String,
    pub message: String,
    pub details: Option<String>,
}

fn trim_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    value[..end].to_string()
}

fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let lower_haystack = haystack.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(haystack.len());
    let mut search_start = 0usize;
    while let Some(rel) = lower_haystack[search_start..].find(&lower_needle) {
        let start = search_start + rel;
        let end = start + needle.len();
        out.push_str(&haystack[search_start..start]);
        out.push_str(replacement);
        search_start = end;
    }
    out.push_str(&haystack[search_start..]);
    out
}

fn redact_email_like_tokens(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0usize;
    while cursor < chars.len() {
        if chars[cursor] != '@' {
            out.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        let mut left = cursor;
        while left > 0 {
            let ch = chars[left - 1];
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '%' | '+' | '-') {
                left -= 1;
            } else {
                break;
            }
        }
        let mut right = cursor + 1;
        let mut saw_domain_dot = false;
        while right < chars.len() {
            let ch = chars[right];
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-') {
                if ch == '.' {
                    saw_domain_dot = true;
                }
                right += 1;
            } else {
                break;
            }
        }
        let local_len = cursor.saturating_sub(left);
        let domain_len = right.saturating_sub(cursor + 1);
        if local_len == 0 || domain_len < 3 || !saw_domain_dot {
            out.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        out.push_str("<email>");
        cursor = right;
    }
    out
}

fn sanitize_log_text(value: &str) -> String {
    let mut sanitized = redact_email_like_tokens(value);
    for (env_key, placeholder) in [
        ("USERPROFILE", "%USERPROFILE%"),
        ("OneDrive", "%ONEDRIVE%"),
        ("APPDATA", "%APPDATA%"),
        ("LOCALAPPDATA", "%LOCALAPPDATA%"),
        ("PROGRAMDATA", "%PROGRAMDATA%"),
        ("TEMP", "%TEMP%"),
        ("TMP", "%TEMP%"),
    ] {
        if let Ok(path) = std::env::var(env_key) {
            sanitized = replace_case_insensitive(&sanitized, &path, placeholder);
        }
    }
    sanitized
}

fn ensure_log_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "log path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create log dir: {e}"))?;
    Ok(())
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn log_root(handle: &AppHandle) -> Result<PathBuf, String> {
    handle
        .path()
        .app_log_dir()
        .map_err(|e| format!("app_log_dir: {e}"))
}

pub fn log_file_path(handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(log_root(handle)?.join(LOG_FILE_NAME))
}

pub fn previous_log_file_path(handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(log_root(handle)?.join(PREVIOUS_LOG_FILE_NAME))
}

pub fn begin_log_session(handle: &AppHandle) -> Result<(), String> {
    let _guard = log_lock()
        .lock()
        .map_err(|_| "log lock poisoned".to_string())?;

    let current = log_file_path(handle)?;
    ensure_log_parent(&current)?;

    let previous = previous_log_file_path(handle)?;
    if previous.exists() {
        let _ = fs::remove_file(&previous);
    }
    if current.exists() {
        fs::rename(&current, &previous)
            .map_err(|e| format!("rotate log: {e}"))?;
    }
    fs::write(&current, "").map_err(|e| format!("init log: {e}"))?;
    Ok(())
}

pub fn append_app_log(
    handle: &AppHandle,
    level: &str,
    source: &str,
    message: &str,
    details: Option<&str>,
) -> Result<(), String> {
    let _guard = log_lock()
        .lock()
        .map_err(|_| "log lock poisoned".to_string())?;

    let path = log_file_path(handle)?;
    ensure_log_parent(&path)?;

    let record = serde_json::json!({
        "tsMs": now_unix_ms(),
        "level": trim_text(&sanitize_log_text(level), 32),
        "source": trim_text(&sanitize_log_text(source), 128),
        "message": trim_text(&sanitize_log_text(message), MAX_MESSAGE_BYTES),
        "details": details.map(|v| trim_text(&sanitize_log_text(v), MAX_DETAILS_BYTES)),
    });

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open log: {e}"))?;

    writeln!(file, "{record}").map_err(|e| format!("write log: {e}"))?;
    Ok(())
}

pub fn read_log_file(path: &Path) -> Result<Vec<LogEntry>, String> {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("open log: {e}")),
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts_ms = v.get("tsMs").and_then(|x| x.as_u64()).unwrap_or(0);
        let level = v
            .get("level")
            .and_then(|x| x.as_str())
            .unwrap_or("info")
            .to_string();
        let source = v
            .get("source")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let message = v
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let details = v
            .get("details")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        out.push(LogEntry {
            ts_ms,
            level,
            source,
            message,
            details,
        });
    }
    Ok(out)
}

pub fn clear_log(handle: &AppHandle) -> Result<(), String> {
    let _guard = log_lock()
        .lock()
        .map_err(|_| "log lock poisoned".to_string())?;
    let path = log_file_path(handle)?;
    ensure_log_parent(&path)?;
    fs::write(&path, "").map_err(|e| format!("clear log: {e}"))?;
    Ok(())
}

pub fn install_panic_hook(handle: AppHandle) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };
        let _ = append_app_log(&handle, "error", "rust.panic", &payload, Some(&location));
        previous(info);
    }));
}
