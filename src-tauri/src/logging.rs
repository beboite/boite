use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const LOG_FILE_NAME: &str = "app.log";
const PREVIOUS_LOG_FILE_NAME: &str = "app.previous.log";
const MAX_MESSAGE_BYTES: usize = 512;
const MAX_DETAILS_BYTES: usize = 16_384;
/// How many records a read hands back. The log grows without bound across a long
/// session, and the caller is a diagnostics view that only ever looks at the end
/// of it, so the whole file has no business crossing an IPC boundary.
const MAX_READ_ENTRIES: usize = 5_000;
/// Where a read starts when the file is bigger than this. Bounds the parse as
/// well as the payload: a single record carries up to `MAX_DETAILS_BYTES`, so
/// counting records alone would still let a read pull in tens of megabytes.
const READ_TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// When the log rolls over on its own.
///
/// Rotation used to happen once, at launch. A desktop app is left open for days
/// and every agent turn writes to this file, so "once at launch" is not a bound
/// — it is a file that grows until something else on the machine complains.
///
/// Twice the read window on purpose: the diagnostics view reads the last 4 MB,
/// so a log that has just rolled over still has more history than anyone can
/// look at.
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

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

/// Replaces anything shaped like an address with `<email>`.
///
/// Written as "copy up to the match, then skip it" rather than
/// "copy every character, then decide": the earlier version pushed the local
/// part before it ever saw the `@` and had no way to take it back, so
/// `someone@example.com` was logged as `someone<email>`. A local part is
/// routinely a person's name, which made the redaction cosmetic.
fn redact_email_like_tokens(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    // How much of `chars` is already in `out`.
    let mut written = 0usize;
    let mut cursor = 0usize;
    while cursor < chars.len() {
        if chars[cursor] != '@' {
            cursor += 1;
            continue;
        }
        let mut left = cursor;
        while left > 0 {
            let ch = chars[left - 1];
            // Alphanumeric rather than ASCII-alphanumeric: `josé@exemple.fr`
            // stopped the walk on the accent, which left the local part empty
            // and the whole address unredacted.
            if ch.is_alphanumeric() || matches!(ch, '.' | '_' | '%' | '+' | '-') {
                left -= 1;
            } else {
                break;
            }
        }
        let mut right = cursor + 1;
        let mut saw_domain_dot = false;
        while right < chars.len() {
            let ch = chars[right];
            if ch.is_alphanumeric() || matches!(ch, '.' | '-') {
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
            cursor += 1;
            continue;
        }
        // A `@` inside a run already redacted cannot happen — `written` only
        // ever moves past a whole match — so `left` is never behind it.
        out.extend(chars[written..left].iter());
        out.push_str("<email>");
        written = right;
        cursor = right;
    }
    out.extend(chars[written..].iter());
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
    roll_over(&log_file_path(handle)?, &previous_log_file_path(handle)?)
}

/// Moves the current log aside and starts an empty one.
///
/// The caller holds the lock. `app.previous.log` is the last roll-over rather
/// than the last launch: a session long enough to fill the file rolls over
/// inside itself, and keeping the launch boundary instead would mean either an
/// unbounded file or a silently discarded half.
///
/// Takes paths rather than the app so it can be run against a scratch
/// directory. Everything below this line is what a test can reach; everything
/// above it is Tauri asking where the log lives.
fn roll_over(current: &Path, previous: &Path) -> Result<(), String> {
    ensure_log_parent(current)?;
    if previous.exists() {
        let _ = fs::remove_file(previous);
    }
    if current.exists() {
        fs::rename(current, previous).map_err(|e| format!("rotate log: {e}"))?;
    }
    fs::write(current, "").map_err(|e| format!("init log: {e}"))?;
    Ok(())
}

/// One record, appended, with a roll-over when the file has had enough.
///
/// The caller holds the lock.
fn append_to(
    current: &Path,
    previous: &Path,
    level: &str,
    source: &str,
    message: &str,
    details: Option<&str>,
) -> Result<(), String> {
    ensure_log_parent(current)?;

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
        .open(current)
        .map_err(|e| format!("open log: {e}"))?;
    writeln!(file, "{record}").map_err(|e| format!("write log: {e}"))?;

    // Read from the handle we already have rather than by stat'ing the path
    // again, and after the write so a record is never split across a roll-over.
    let full = file
        .metadata()
        .map(|m| m.len() >= MAX_LOG_BYTES)
        .unwrap_or(false);
    drop(file);
    if full {
        roll_over(current, previous)?;
    }
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

    append_to(
        &log_file_path(handle)?,
        &previous_log_file_path(handle)?,
        level,
        source,
        message,
        details,
    )
}

/// Says something went wrong, to the log and to whoever is watching stderr.
///
/// For the startup paths. They ran before this existed and wrote to stderr
/// alone, which on a packaged desktop app is nowhere: the agent endpoint could
/// fail to bind, every terminal would launch with no credentials, and the only
/// record of why was in a console nobody has. An agent asked to work out what
/// happened had nothing to read.
pub fn warn_to_log(handle: &AppHandle, source: &str, message: &str) {
    eprintln!("[boite/{source}] {message}");
    let _ = append_app_log(handle, "warn", source, message, None);
}

fn parse_log_line(line: &str) -> Option<LogEntry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    Some(LogEntry {
        ts_ms: v.get("tsMs").and_then(|x| x.as_u64()).unwrap_or(0),
        level: v
            .get("level")
            .and_then(|x| x.as_str())
            .unwrap_or("info")
            .to_string(),
        source: v
            .get("source")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        message: v
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        details: v
            .get("details")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    })
}

/// The tail of the log, never more than `MAX_READ_ENTRIES` records.
pub fn read_log_file(path: &Path) -> Result<Vec<LogEntry>, String> {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("open log: {e}")),
    };

    let len = file
        .metadata()
        .map_err(|e| format!("stat log: {e}"))?
        .len();
    let seeked = len > READ_TAIL_BYTES;
    if seeked {
        file.seek(SeekFrom::Start(len - READ_TAIL_BYTES))
            .map_err(|e| format!("seek log: {e}"))?;
    }

    // Keeping raw lines and parsing afterwards means a file with a million
    // records costs a million `String`s read one at a time, not a million parsed
    // JSON values held at once.
    let mut recent: VecDeque<String> = VecDeque::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else { continue };
        // A byte offset lands mid-record, so the first line back is the tail half
        // of a record that started before the offset.
        if seeked && index == 0 {
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        if recent.len() == MAX_READ_ENTRIES {
            recent.pop_front();
        }
        recent.push_back(line);
    }

    Ok(recent.iter().filter_map(|l| parse_log_line(l)).collect())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("boite-log-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The bound that did not exist. Rotation used to happen once at launch, so
    /// a desktop left open for days wrote one file until something else on the
    /// machine complained.
    #[test]
    fn a_log_that_fills_up_rolls_over_instead_of_growing() {
        let dir = scratch("rollover");
        let current = dir.join("app.log");
        let previous = dir.join("app.previous.log");

        let details = "x".repeat(MAX_DETAILS_BYTES);
        let mut wrote = 0;
        while current.metadata().map(|m| m.len()).unwrap_or(0) < MAX_LOG_BYTES / 2 {
            append_to(&current, &previous, "info", "test", "filling", Some(&details)).unwrap();
            wrote += 1;
            assert!(wrote < 10_000, "the file is not growing");
        }
        assert!(!previous.exists(), "nothing has rolled over yet");

        while !previous.exists() {
            append_to(&current, &previous, "info", "test", "filling", Some(&details)).unwrap();
            wrote += 1;
            assert!(wrote < 10_000, "the file never rolled over");
        }
        // The roll-over is a move, not a delete: what was written is still
        // there to read, and the live file starts again from nothing.
        assert!(previous.metadata().unwrap().len() >= MAX_LOG_BYTES);
        assert_eq!(current.metadata().unwrap().len(), 0);

        // And the next record lands in the fresh file rather than being lost.
        append_to(&current, &previous, "info", "test", "after", None).unwrap();
        let after = read_log_file(&current).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].message, "after");

        let _ = fs::remove_dir_all(&dir);
    }

    /// A record is never split across the boundary: the size is checked after
    /// the write, so the line that tipped it over is whole in the file it
    /// landed in.
    #[test]
    fn a_record_is_whole_on_whichever_side_it_lands() {
        let dir = scratch("whole");
        let current = dir.join("app.log");
        let previous = dir.join("app.previous.log");

        let details = "y".repeat(MAX_DETAILS_BYTES);
        for _ in 0..600 {
            append_to(&current, &previous, "warn", "test", "line", Some(&details)).unwrap();
        }
        for path in [&current, &previous] {
            let text = fs::read_to_string(path).unwrap_or_default();
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                serde_json::from_str::<serde_json::Value>(line)
                    .unwrap_or_else(|e| panic!("a record was cut in half: {e}"));
            }
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// Paths and addresses in a message are what makes a log unshareable, and a
    /// diagnostics view exists to be shared.
    ///
    /// The local part is the half that matters: `firstname.lastname@` is a
    /// person. It used to survive, because every character was copied out before
    /// the `@` that would have condemned it was ever seen.
    #[test]
    fn what_identifies_the_user_never_reaches_the_file() {
        let dir = scratch("redact");
        let current = dir.join("app.log");
        let previous = dir.join("app.previous.log");
        let said = |message: &str| {
            let _ = fs::remove_file(&current);
            append_to(&current, &previous, "error", "test", message, None).unwrap();
            read_log_file(&current).unwrap().remove(0).message
        };

        assert_eq!(said("mail me at someone@example.com"), "mail me at <email>");
        assert_eq!(
            said("from first.last@sub.domain.org to a.b@c.dev"),
            "from <email> to <email>"
        );
        // Not an address: nothing to redact, and nothing lost either.
        assert_eq!(said("user@localhost said no"), "user@localhost said no");
        assert_eq!(said("100% @ the door"), "100% @ the door");
        assert_eq!(said("résumé from éric@exemple.fr"), "résumé from <email>");

        let _ = fs::remove_dir_all(&dir);
    }
}
