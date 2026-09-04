//! The desktop's half of the log.
//!
//! Everything that used to be here, the JSON format, the redaction, the
//! rotation, the bounded tail read, is now `boite_core::log`, because the
//! desktop is one host of four and a rule written on this side never reached
//! `boite-server`, `boite-mcp` or the webview. What is left is what only this
//! process can answer: where Tauri puts the log directory, and the shape the
//! diagnostics panel already reads.
//!
//! The public functions kept their names and signatures on purpose. Half of
//! `src-tauri` calls them, and turning that into a sweep would have put the
//! change and the risk in one commit.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use boite_core::log::{self, LogConfig, Query, Record};

/// The name this host writes under. Every record carries it, and it is what a
/// query filters on.
pub const HOST: &str = "desktop";

/// One line of the log, as the diagnostics panel reads it.
///
/// Not [`Record`]: the panel has a source column and a details pane, and those
/// are `target` and a field rather than concepts of their own. Mapped rather
/// than replaced so the webview stays untouched by this change.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub ts_ms: u64,
    pub level: String,
    pub source: String,
    pub message: String,
    pub details: Option<String>,
}

impl From<Record> for LogEntry {
    fn from(record: Record) -> Self {
        // `details` is one field by convention on this side, and everything
        // else a record carries is folded in beside it rather than dropped: a
        // panel showing nothing is how a field nobody mapped goes unnoticed.
        let details = match record.fields.get("details").and_then(|v| v.as_str()) {
            Some(text) => Some(text.to_string()),
            None if record.fields.is_empty() => None,
            None => serde_json::to_string(&record.fields).ok(),
        };
        LogEntry {
            ts_ms: record.ts,
            level: record.level,
            source: record.target,
            message: record.msg,
            details,
        }
    }
}

fn log_root(handle: &AppHandle) -> Result<PathBuf, String> {
    handle
        .path()
        .app_log_dir()
        .map_err(|e| format!("app_log_dir: {e}"))
}

/// The file this host writes, for the panel's "open the log" button.
pub fn log_file_path(handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(log_root(handle)?.join(format!("{HOST}.jsonl")))
}

/// The generation before the current one.
///
/// The panel offers "this session" and "the previous one"; a rotation is what
/// that boundary is made of, and `boite_core::log` keeps two of them.
pub fn previous_log_file_path(handle: &AppHandle) -> Result<PathBuf, String> {
    Ok(log_root(handle)?.join(format!("{HOST}.1.jsonl")))
}

/// Brings the log up for this process.
///
/// Called once, from `setup`. Installs the `tracing` layer, so everything the
/// desktop and every crate under it logs through a `tracing` macro lands in the
/// same file as the calls below.
///
/// It no longer rolls the file over at launch. Rotation is by size now, and a
/// launch-time roll-over meant a crash loop threw away the crash: three
/// restarts and the record of the first one was two generations back.
pub fn begin_log_session(handle: &AppHandle) -> Result<(), String> {
    let dir = log_root(handle)?;
    log::init(LogConfig {
        dir,
        host: HOST.to_string(),
        // A packaged desktop app has no console to print to, and printing twice
        // on a `bun run dev:isolated` would double every line in the terminal
        // the dev server is already using.
        extra_stderr: false,
    })?;
    Ok(())
}

/// One record from this side of the app.
///
/// The `handle` is no longer read, the log directory is settled at
/// [`begin_log_session`], and stays in the signature because thirty call sites
/// pass it and none of them would read better without it.
pub fn append_app_log(
    _handle: &AppHandle,
    level: &str,
    source: &str,
    message: &str,
    details: Option<&str>,
) -> Result<(), String> {
    let mut record = Record::new(HOST, level, source, message);
    if let Some(details) = details {
        record
            .fields
            .insert("details".to_string(), serde_json::Value::String(details.to_string()));
    }
    log::write(record);
    Ok(())
}

/// One record the webview produced.
///
/// Tagged `webview` rather than `desktop`, so a reader can tell a frame that
/// stalled from a Rust command that refused. It lands in this process's file:
/// the browser has no file of its own, which is the whole reason it goes
/// through here.
pub fn append_webview_log(
    level: &str,
    source: &str,
    message: &str,
    details: Option<&str>,
) -> Result<(), String> {
    let mut record = Record::new("webview", level, source, message);
    if let Some(details) = details {
        record
            .fields
            .insert("details".to_string(), serde_json::Value::String(details.to_string()));
    }
    log::write(record);
    Ok(())
}

/// Says something went wrong, to the log and to whoever is watching stderr.
///
/// For the startup paths. They ran before this existed and wrote to stderr
/// alone, which on a packaged desktop app is nowhere: the agent endpoint could
/// fail to bind, every terminal would launch with no credentials, and the only
/// record of why was in a console nobody has.
pub fn warn_to_log(handle: &AppHandle, source: &str, message: &str) {
    eprintln!("[boite/{source}] {message}");
    let _ = append_app_log(handle, "warn", source, message, None);
}

/// The tail of one host's files, in the panel's shape.
///
/// Reads through `boite_core::log` rather than parsing lines here: the bound on
/// how much of a big file is read, and the merge across generations, are both
/// the module's.
pub fn read_log_file(path: &Path) -> Result<Vec<LogEntry>, String> {
    let Some(dir) = path.parent() else {
        return Ok(Vec::new());
    };
    // Which host and which generation this path names. A caller asking for
    // `desktop.1.jsonl` wants the previous generation and nothing newer.
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let host = name
        .strip_suffix(".jsonl")
        .and_then(|stem| stem.split('.').next())
        .unwrap_or(HOST)
        .to_string();
    let previous_only = name.contains(".1.");
    if previous_only {
        // One generation, read directly: a query merges every file of the host,
        // which is the opposite of what "the previous session" means.
        return Ok(log::read_generation(path)
            .into_iter()
            .map(LogEntry::from)
            .collect());
    }
    Ok(log::query_in(
        dir,
        &Query {
            host: Some(host),
            limit: Some(log::MAX_QUERY_LIMIT),
            ..Query::default()
        },
    )
    .into_iter()
    .map(LogEntry::from)
    .collect())
}

/// Empties this host's current file.
///
/// The rotated generations stay: the button says "clear the log", and taking
/// away the two files a crash from ten minutes ago is in is not what anybody
/// pressing it means.
pub fn clear_log(handle: &AppHandle) -> Result<(), String> {
    let path = log_file_path(handle)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create log dir: {e}"))?;
    }
    std::fs::write(&path, "").map_err(|e| format!("clear log: {e}"))
}

/// A panic, on the log, before it reaches the previous hook.
pub fn install_panic_hook(_handle: AppHandle) {
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
        let mut record = Record::new(HOST, "error", "rust.panic", &payload);
        record
            .fields
            .insert("at".to_string(), serde_json::Value::String(location));
        log::write(record);
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The panel's shape, from a record.
    ///
    /// The mapping is the whole of what stayed on this side, and it is where a
    /// field would go missing without anything failing: an entry with an empty
    /// details pane looks like an entry that had no details.
    #[test]
    fn a_record_becomes_the_entry_the_panel_already_reads() {
        let mut record = Record::new(HOST, "warn", "backend.pty", "the shell would not start");
        record.ts = 1234;
        record
            .fields
            .insert("details".into(), serde_json::Value::String("exit 1".into()));
        let entry = LogEntry::from(record);
        assert_eq!(entry.ts_ms, 1234);
        assert_eq!(entry.level, "warn");
        assert_eq!(entry.source, "backend.pty");
        assert_eq!(entry.message, "the shell would not start");
        assert_eq!(entry.details.as_deref(), Some("exit 1"));

        // A record whose fields are not the desktop's `details` convention
        // still shows them, rather than an empty pane.
        let mut structured = Record::new(HOST, "info", "bus", "refused");
        structured
            .fields
            .insert("method".into(), serde_json::Value::String("git.commit".into()));
        let entry = LogEntry::from(structured);
        assert!(entry.details.unwrap().contains("git.commit"));

        // And one with nothing says nothing.
        assert!(LogEntry::from(Record::new(HOST, "info", "t", "m"))
            .details
            .is_none());
    }
}
