//! One log, across the three Rust hosts and the webview.
//!
//! Before this module there were two logs and neither answered a question: the
//! desktop wrote `app.log`, a flat `{tsMs, level, source, message}` with no way
//! to say which thread a line belonged to, and `boite-server` printed
//! `tracing` events to a stderr nobody keeps. `boite-mcp` wrote nothing at all.
//! An agent asked "what happened to thread X" had three places to look, two of
//! which do not name a thread.
//!
//! So the format is one [`Record`] per line of JSON, the ids that answer that
//! question are top level rather than buried in `fields`, and every host writes
//! its own file in one directory so a reader merges them on one clock.
//!
//! Rust code logs through the `tracing` macros with those names as fields
//! (`tracing::info!(thread = %id, "pty.spawned")`). [`layer`] turns each event
//! into a record, lifting `thread`, `turn`, `request` and `device` out of the
//! event or out of any span enclosing it, so a caller that opened
//! `bus.call{method, thread}` never repeats the thread on the events inside it.
//!
//! This crate takes no async runtime, and this module does not change that: a
//! write is a `Mutex` and a `writeln!`, on whichever thread logged.

use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::field::{Field, Visit};
use tracing::Subscriber;
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

/// When a host's file rolls over. Two previous are kept, so the floor on what
/// is readable is 8 MB and the ceiling on what one host costs is 24 MB.
pub const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
/// How many rotated files survive a roll-over.
pub const KEPT_ROTATIONS: usize = 2;
/// How many records stay in memory for [`tail`].
pub const RING_CAPACITY: usize = 2_000;
/// Where a file read starts when the file is bigger than this.
///
/// Bounds the parse as well as the answer: a query that walks four hosts times
/// three files would otherwise read the whole 24 MB of each of them to hand
/// back a hundred lines.
const READ_TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// The hard ceiling on what one [`query`] hands back, whatever it asked for.
pub const MAX_QUERY_LIMIT: usize = 5_000;
/// What a message is trimmed to. Long enough for a stack frame, short enough
/// that one record cannot fill a rotation on its own.
const MAX_MSG_BYTES: usize = 4_096;
/// What one field value is trimmed to.
const MAX_FIELD_BYTES: usize = 4_096;

/// The ids that are lifted out of an event or its spans to the top level.
///
/// Top level rather than inside `fields` so a filter never parses a map: this
/// is the whole reason the format is not `tracing`'s own JSON.
const LIFTED: [&str; 4] = ["thread", "turn", "request", "device"];

/// One line of the log.
///
/// Field names are exactly what goes on the wire and into the file. They are
/// single words on purpose: there is no camelCase to get wrong on the way to
/// the webview, and an agent grepping the raw file reads the same names the
/// MCP tool prints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    /// Unix milliseconds. The one clock every host sorts on.
    pub ts: u64,
    /// Per-process counter, so two records in the same millisecond keep their
    /// order. Not unique across hosts, and not meant to be.
    pub seq: u64,
    /// `desktop`, `server`, `mcp` or `webview`.
    pub host: String,
    /// `trace`, `debug`, `info`, `warn` or `error`, lowercase.
    pub level: String,
    /// The module path a `tracing` event came from, or what a caller named.
    pub target: String,
    pub msg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    /// The innermost span the event was inside, by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<String>,
    /// Everything else the event carried, in the order a `BTreeMap` gives.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, Value>,
}

impl Record {
    /// A record with nothing but what every record must have.
    pub fn new(host: &str, level: &str, target: &str, msg: &str) -> Self {
        Self {
            ts: now_ms(),
            seq: 0,
            host: host.to_string(),
            level: normalize_level(level),
            target: target.to_string(),
            msg: msg.to_string(),
            thread: None,
            turn: None,
            request: None,
            device: None,
            span: None,
            fields: BTreeMap::new(),
        }
    }

    /// Sets whichever of the four lifted ids this name is, or nothing.
    fn set_lifted(&mut self, name: &str, value: String) {
        match name {
            "thread" => self.thread = Some(value),
            "turn" => self.turn = Some(value),
            "request" => self.request = Some(value),
            "device" => self.device = Some(value),
            _ => {}
        }
    }

    fn lifted(&self, name: &str) -> Option<&String> {
        match name {
            "thread" => self.thread.as_ref(),
            "turn" => self.turn.as_ref(),
            "request" => self.request.as_ref(),
            "device" => self.device.as_ref(),
            _ => None,
        }
    }

    /// Redacts what identifies the user, in place.
    ///
    /// Applied to `msg` and to every string field. Numbers and booleans carry
    /// nothing to redact, and walking them would cost a clone per record.
    fn redact(&mut self) {
        self.msg = trim_text(&redact(&self.msg), MAX_MSG_BYTES);
        for value in self.fields.values_mut() {
            if let Value::String(s) = value {
                *value = Value::String(trim_text(&redact(s), MAX_FIELD_BYTES));
            }
        }
        for name in LIFTED {
            if let Some(current) = self.lifted(name) {
                let cleaned = redact(current);
                self.set_lifted(name, cleaned);
            }
        }
    }
}

/// Ranks a level so a filter can say "this and worse".
fn severity(level: &str) -> u8 {
    match level.to_ascii_lowercase().as_str() {
        "trace" => 0,
        "debug" => 1,
        "warn" | "warning" => 3,
        "error" => 4,
        // `info` and anything a caller invented: an unknown word is not a
        // reason to drop a record out of every filtered read.
        _ => 2,
    }
}

fn normalize_level(level: &str) -> String {
    match severity(level) {
        0 => "trace",
        1 => "debug",
        3 => "warn",
        4 => "error",
        _ => "info",
    }
    .to_string()
}

/// Now, in milliseconds since the epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

// --------------------------------------------------------------- redaction

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

/// What makes a log unshareable, taken out of it.
///
/// Addresses become `<email>`; a directory that is the user's becomes the name
/// of the variable that holds it, so a reader still sees which directory it was
/// without seeing whose. Moved here from `src-tauri/src/logging.rs` unchanged:
/// the desktop is now one host of four and the rule belongs to all of them.
pub fn redact(value: &str) -> String {
    let mut sanitized = redact_email_like_tokens(value);
    for (env_key, placeholder) in [
        ("USERPROFILE", "%USERPROFILE%"),
        ("OneDrive", "%ONEDRIVE%"),
        ("APPDATA", "%APPDATA%"),
        ("LOCALAPPDATA", "%LOCALAPPDATA%"),
        ("PROGRAMDATA", "%PROGRAMDATA%"),
        ("TEMP", "%TEMP%"),
        ("TMP", "%TEMP%"),
        ("HOME", "$HOME"),
    ] {
        if let Ok(path) = std::env::var(env_key) {
            // A one- or two-character variable is not a path, and substituting
            // it would rewrite ordinary words.
            if path.len() < 4 {
                continue;
            }
            sanitized = replace_case_insensitive(&sanitized, &path, placeholder);
        }
    }
    sanitized
}

// ------------------------------------------------------------------- files

/// The current file of a host, and the two it rolls over into.
fn file_for(dir: &Path, host: &str, generation: usize) -> PathBuf {
    if generation == 0 {
        dir.join(format!("{host}.jsonl"))
    } else {
        dir.join(format!("{host}.{generation}.jsonl"))
    }
}

/// Moves the current file aside and starts an empty one.
///
/// The oldest generation is dropped rather than merged: a bound that has to be
/// maintained by hand is not a bound. `KEPT_ROTATIONS` files survive, so a
/// reader always has at least the last 8 MB and never more than 24.
fn roll_over(dir: &Path, host: &str) -> Result<(), String> {
    let oldest = file_for(dir, host, KEPT_ROTATIONS);
    if oldest.exists() {
        let _ = fs::remove_file(&oldest);
    }
    for generation in (1..KEPT_ROTATIONS).rev() {
        let from = file_for(dir, host, generation);
        if from.exists() {
            let _ = fs::rename(&from, file_for(dir, host, generation + 1));
        }
    }
    let current = file_for(dir, host, 0);
    if current.exists() {
        fs::rename(&current, file_for(dir, host, 1)).map_err(|e| format!("rotate log: {e}"))?;
    }
    Ok(())
}

/// Appends one already-serialized line, rolling over when the file has had
/// enough.
///
/// The size is read after the write, from the handle rather than by stat'ing
/// the path again, so a record is never split across the boundary: the line
/// that tipped the file over is whole in the file it landed in.
fn append_line(dir: &Path, host: &str, line: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create log dir: {e}"))?;
    let current = file_for(dir, host, 0);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&current)
        .map_err(|e| format!("open log: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("write log: {e}"))?;
    let full = file
        .metadata()
        .map(|m| m.len() >= MAX_LOG_BYTES)
        .unwrap_or(false);
    drop(file);
    if full {
        roll_over(dir, host)?;
    }
    Ok(())
}

/// The tail of one file, parsed, oldest first.
///
/// Bounded the way the desktop's reader already was: a big file is read from a
/// byte offset near its end, and the first line back from that offset is the
/// tail half of a record that started before it, so it is dropped.
fn read_file(path: &Path, keep: usize) -> Vec<Record> {
    let Ok(mut file) = fs::File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let seeked = len > READ_TAIL_BYTES;
    if seeked && file.seek(SeekFrom::Start(len - READ_TAIL_BYTES)).is_err() {
        return Vec::new();
    }
    let mut recent: VecDeque<String> = VecDeque::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else { continue };
        if seeked && index == 0 {
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        if recent.len() == keep {
            recent.pop_front();
        }
        recent.push_back(line);
    }
    recent
        .iter()
        .filter_map(|l| serde_json::from_str::<Record>(l).ok())
        .collect()
}

/// One named file, parsed, oldest first.
///
/// For a caller that means one generation rather than a host's whole history:
/// "the previous session" is a file, and merging it with the current one is
/// the opposite of what that asks for.
pub fn read_generation(path: &Path) -> Vec<Record> {
    read_file(path, MAX_QUERY_LIMIT)
}

/// Every `<host>.jsonl` and `<host>.N.jsonl` in a directory, by host name.
fn files_in(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(stem) = name.strip_suffix(".jsonl") else {
            continue;
        };
        // `desktop` and `desktop.1` both belong to the host `desktop`.
        let host = stem.split('.').next().unwrap_or(stem).to_string();
        if host.is_empty() {
            continue;
        }
        out.push((host, path));
    }
    out
}

// ------------------------------------------------------------------ queries

/// What a reader is asking for.
///
/// Every field is optional except the limit, and an absent field is "do not
/// filter on this" rather than a default value: a query with nothing set is
/// the whole log, which is what a settings panel opens on.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Query {
    /// Unix ms, inclusive.
    pub since: Option<u64>,
    /// Unix ms, inclusive.
    pub until: Option<u64>,
    /// This level and worse. `warn` answers warnings and errors.
    pub level: Option<String>,
    pub host: Option<String>,
    pub thread: Option<String>,
    pub turn: Option<String>,
    /// A prefix of the target, so `boite_core::command` catches its children.
    pub target: Option<String>,
    /// Case-insensitive, matched against the message and the serialized fields.
    pub text: Option<String>,
    pub limit: Option<usize>,
}

impl Query {
    fn effective_limit(&self) -> usize {
        self.limit.unwrap_or(200).clamp(1, MAX_QUERY_LIMIT)
    }

    fn matches(&self, record: &Record) -> bool {
        if let Some(since) = self.since {
            if record.ts < since {
                return false;
            }
        }
        if let Some(until) = self.until {
            if record.ts > until {
                return false;
            }
        }
        if let Some(level) = &self.level {
            if severity(&record.level) < severity(level) {
                return false;
            }
        }
        if let Some(host) = &self.host {
            if !host.is_empty() && record.host != *host {
                return false;
            }
        }
        if let Some(thread) = &self.thread {
            if record.thread.as_deref() != Some(thread.as_str()) {
                return false;
            }
        }
        if let Some(turn) = &self.turn {
            if record.turn.as_deref() != Some(turn.as_str()) {
                return false;
            }
        }
        if let Some(target) = &self.target {
            if !record.target.starts_with(target.as_str()) {
                return false;
            }
        }
        if let Some(text) = &self.text {
            if !text.is_empty() {
                let needle = text.to_lowercase();
                let in_msg = record.msg.to_lowercase().contains(&needle);
                let in_fields = !in_msg
                    && serde_json::to_string(&record.fields)
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(&needle);
                if !in_msg && !in_fields {
                    return false;
                }
            }
        }
        true
    }
}

/// The last records of every host in a directory, merged on one clock.
///
/// Each file is read and filtered on its own, so a query for one host never
/// parses another's, and the merge is a sort on `(ts, seq)` at the end. Newest
/// last, the order a log is read in.
pub fn query_in(dir: &Path, query: &Query) -> Vec<Record> {
    let limit = query.effective_limit();
    let mut all: Vec<Record> = Vec::new();
    for (host, path) in files_in(dir) {
        if let Some(wanted) = &query.host {
            if !wanted.is_empty() && host != *wanted {
                continue;
            }
        }
        for record in read_file(&path, MAX_QUERY_LIMIT) {
            if query.matches(&record) {
                all.push(record);
            }
        }
    }
    all.sort_by_key(|r| (r.ts, r.seq));
    if all.len() > limit {
        all.drain(..all.len() - limit);
    }
    all
}

/// [`query_in`] against the directory this process logs to.
///
/// Empty when nothing has installed the layer, which is honest: a host with no
/// log directory has no files to merge.
pub fn query(query: &Query) -> Vec<Record> {
    match state() {
        Some(state) => query_in(&state.dir, query),
        None => Vec::new(),
    }
}

/// The last records this process wrote, from memory.
///
/// The ring is what a live view reads: it costs no file read, and it holds
/// only this host's records, which is why `host` here is a filter rather than
/// the merge [`query`] does.
pub fn tail(limit: usize, level: Option<&str>, host: Option<&str>) -> Vec<Record> {
    let Some(state) = state() else {
        return Vec::new();
    };
    let ring = match state.ring.lock() {
        Ok(ring) => ring,
        Err(poisoned) => poisoned.into_inner(),
    };
    let limit = limit.clamp(1, RING_CAPACITY);
    let mut out: Vec<Record> = ring
        .iter()
        .filter(|r| level.is_none_or(|l| severity(&r.level) >= severity(l)))
        .filter(|r| host.is_none_or(|h| h.is_empty() || r.host == h))
        .cloned()
        .collect();
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    out
}

// -------------------------------------------------------------- subscribers

/// What [`unsubscribe`] takes back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SubscriptionId(pub u64);

type Sink = Box<dyn Fn(&Record) + Send + Sync>;

/// Calls back on every record this process writes.
///
/// How a host pushes live: the desktop emits to its window, the server
/// coalesces into a `log.record` event. The callback runs on the thread that
/// logged, inside the write lock's neighbourhood, so it must not log itself and
/// must not block — both hosts hand the record to a channel and return.
pub fn subscribe(sink: Sink) -> SubscriptionId {
    let subscribers = subscribers();
    let id = SubscriptionId(NEXT_SUBSCRIPTION.fetch_add(1, Ordering::Relaxed));
    let mut guard = match subscribers.write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.push((id, sink));
    id
}

/// Stops a subscription. Unknown ids are ignored: a double unsubscribe is not
/// an error worth propagating out of a teardown path.
pub fn unsubscribe(id: SubscriptionId) {
    let mut guard = match subscribers().write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.retain(|(existing, _)| *existing != id);
}

static NEXT_SUBSCRIPTION: AtomicU64 = AtomicU64::new(1);

fn subscribers() -> &'static RwLock<Vec<(SubscriptionId, Sink)>> {
    static SUBSCRIBERS: OnceLock<RwLock<Vec<(SubscriptionId, Sink)>>> = OnceLock::new();
    SUBSCRIBERS.get_or_init(|| RwLock::new(Vec::new()))
}

// -------------------------------------------------------------------- state

/// What one initialised process holds.
struct LogState {
    dir: PathBuf,
    host: String,
    seq: AtomicU64,
    ring: Mutex<VecDeque<Record>>,
    /// One writer at a time, so two threads never interleave half a line.
    write: Mutex<()>,
    reload: tracing_subscriber::reload::Handle<
        tracing_subscriber::EnvFilter,
        tracing_subscriber::Registry,
    >,
}

static STATE: OnceLock<&'static LogState> = OnceLock::new();

fn state() -> Option<&'static LogState> {
    STATE.get().copied()
}

/// Where to log, and as whom.
#[derive(Debug, Clone)]
pub struct LogConfig {
    /// The directory every host of this machine writes into.
    pub dir: PathBuf,
    /// `desktop`, `server` or `mcp`. Names the file, and every record.
    pub host: String,
    /// Also print to stderr, compactly. A server is watched from a console;
    /// a packaged desktop app has no console to print to.
    pub extra_stderr: bool,
}

/// What a host holds onto after [`init`].
///
/// Small on purpose: the interesting operations are free functions, because
/// they have to be reachable from a `tracing` macro's expansion, which carries
/// no handle.
#[derive(Debug, Clone)]
pub struct LogHandle {
    dir: PathBuf,
    host: String,
}

impl LogHandle {
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn host(&self) -> &str {
        &self.host
    }
}

/// The filter this process starts with.
///
/// `BOITE_LOG` in `EnvFilter` syntax when it is set. Otherwise `info`, plus the
/// two targets a developer is nearly always asking about — the pilot and the
/// bus — at `debug` in a debug build. A release build never turns those on by
/// itself: a level is a cost paid on every event, and a packaged app has no
/// console to justify it.
pub fn default_directives() -> String {
    if let Ok(from_env) = std::env::var("BOITE_LOG") {
        let trimmed = from_env.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if cfg!(debug_assertions) {
        "info,boite_pilot=debug,boite_core::command=debug".to_string()
    } else {
        "info".to_string()
    }
}

/// The bundle identifier the desktop app ships under.
const DESKTOP_IDENTIFIER: &str = "com.boite.desktop";

/// Where the desktop app on this machine keeps its log.
///
/// The default for `boite-server` and `boite-mcp`, so one boite's hosts write
/// into one directory and a query merges them rather than answering for
/// whichever binary the reader happened to ask. The same rule Tauri applies:
/// `%LOCALAPPDATA%\<id>\logs` on Windows, `~/Library/Logs/<id>` on macOS, and
/// the XDG data directory's `<id>/logs` elsewhere.
///
/// Computed, never read: the directory it names holds the user's live install,
/// and a default is the only thing anything here does with it.
pub fn desktop_log_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return dirs::home_dir().map(|home| home.join("Library/Logs").join(DESKTOP_IDENTIFIER));
    }
    dirs::data_local_dir().map(|dir| dir.join(DESKTOP_IDENTIFIER).join("logs"))
}

/// Installs the layer, once per process.
///
/// A second call is a no-op that hands back the handle the first one made, and
/// deliberately not an error: three hosts and their tests all reach for this,
/// and "the log is already up" is the answer rather than a failure to report.
/// The directory is created here, so a caller that cannot write gets its
/// refusal at startup rather than at the first event.
pub fn init(config: LogConfig) -> Result<LogHandle, String> {
    if let Some(existing) = state() {
        return Ok(LogHandle {
            dir: existing.dir.clone(),
            host: existing.host.clone(),
        });
    }
    fs::create_dir_all(&config.dir).map_err(|e| format!("create log dir: {e}"))?;

    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let filter = tracing_subscriber::EnvFilter::new(default_directives());
    let (filter, reload) = tracing_subscriber::reload::Layer::new(filter);

    let state: &'static LogState = Box::leak(Box::new(LogState {
        dir: config.dir.clone(),
        host: config.host.clone(),
        seq: AtomicU64::new(1),
        ring: Mutex::new(VecDeque::with_capacity(RING_CAPACITY)),
        write: Mutex::new(()),
        reload,
    }));
    // Two processes racing here would each have leaked a state; the loser's is
    // dropped on the floor rather than installed, which is one allocation and
    // no divergence.
    let _ = STATE.set(state);

    let stderr = config.extra_stderr.then(|| {
        tracing_subscriber::fmt::layer()
            .compact()
            .with_writer(std::io::stderr)
    });

    tracing_subscriber::registry()
        .with(filter)
        .with(BoiteLayer)
        .with(stderr)
        .try_init()
        .map_err(|e| format!("install the log layer: {e}"))?;

    Ok(LogHandle {
        dir: config.dir,
        host: config.host,
    })
}

/// The filter directive this process is running.
pub fn level() -> String {
    match state() {
        Some(state) => state
            .reload
            .with_current(|filter| filter.to_string())
            .unwrap_or_else(|_| default_directives()),
        None => default_directives(),
    }
}

/// Changes the filter without a restart.
///
/// The whole directive, not one target: `EnvFilter` has no notion of amending
/// itself, and a caller that wants to add a target sends the string it wants.
pub fn set_level(directives: &str) -> Result<String, String> {
    let state = state().ok_or("this Boite has no log to change the level of")?;
    let filter = tracing_subscriber::EnvFilter::try_new(directives)
        .map_err(|e| format!("that is not a filter: {e}"))?;
    let text = filter.to_string();
    state
        .reload
        .reload(filter)
        .map_err(|e| format!("change the level: {e}"))?;
    Ok(text)
}

/// The host this process logs as, or `unknown` before [`init`].
pub fn host() -> String {
    state()
        .map(|s| s.host.clone())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Where this process logs, when it logs anywhere.
pub fn dir() -> Option<PathBuf> {
    state().map(|s| s.dir.clone())
}

/// Writes one record: redacted, stamped, ringed, appended, fanned out.
///
/// The door for records that did not come from a `tracing` macro — the
/// webview's own, and a host bridging an older API. A record whose `host` is
/// empty is stamped with this process's; one that names `webview` keeps it,
/// which is how a browser's records land in the desktop's file without
/// pretending to have come from it.
pub fn write(mut record: Record) {
    let Some(state) = state() else { return };
    if record.host.is_empty() {
        record.host = state.host.clone();
    }
    if record.ts == 0 {
        record.ts = now_ms();
    }
    record.level = normalize_level(&record.level);
    record.seq = state.seq.fetch_add(1, Ordering::Relaxed);
    record.redact();

    let line = match serde_json::to_string(&record) {
        Ok(line) => line,
        // A record that will not serialize is a bug in whoever built it, and
        // dropping it is better than panicking inside a log call.
        Err(_) => return,
    };
    {
        let guard = match state.write.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        // Written under the same file this process owns whatever the record
        // says its host is: `webview` records are the desktop's to keep.
        let _ = append_line(&state.dir, &state.host, &line);
        drop(guard);
    }
    {
        let mut ring = match state.ring.lock() {
            Ok(ring) => ring,
            Err(poisoned) => poisoned.into_inner(),
        };
        if ring.len() == RING_CAPACITY {
            ring.pop_front();
        }
        ring.push_back(record.clone());
    }
    let guard = match subscribers().read() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (_, sink) in guard.iter() {
        sink(&record);
    }
}

// -------------------------------------------------------------------- layer

/// Reads a `tracing` event or span into a record's fields.
struct Collector {
    msg: String,
    fields: BTreeMap<String, Value>,
}

impl Collector {
    fn new() -> Self {
        Self {
            msg: String::new(),
            fields: BTreeMap::new(),
        }
    }

    fn put(&mut self, field: &Field, value: Value) {
        if field.name() == "message" {
            self.msg = value.as_str().map(str::to_string).unwrap_or(value.to_string());
            return;
        }
        self.fields.insert(field.name().to_string(), value);
    }
}

impl Visit for Collector {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, Value::String(format!("{value:?}")));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, Value::String(value.to_string()));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, Value::Bool(value));
    }
}

/// What a span carries down to the events inside it.
#[derive(Debug, Clone, Default)]
struct SpanFields(BTreeMap<String, Value>);

/// Turns every `tracing` event into a [`Record`].
///
/// The lift is the point: `bus.call{method, thread}` names the thread once, and
/// every event inside it comes out with `thread` at the top level. An event
/// that names one itself wins over its spans, and the innermost span wins over
/// an outer one, which is the order a reader would guess.
pub struct BoiteLayer;

impl<S> Layer<S> for BoiteLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(
        &self,
        attrs: &tracing::span::Attributes<'_>,
        id: &tracing::span::Id,
        ctx: Context<'_, S>,
    ) {
        let Some(span) = ctx.span(id) else { return };
        let mut collector = Collector::new();
        attrs.record(&mut collector);
        span.extensions_mut().insert(SpanFields(collector.fields));
    }

    fn on_record(
        &self,
        id: &tracing::span::Id,
        values: &tracing::span::Record<'_>,
        ctx: Context<'_, S>,
    ) {
        let Some(span) = ctx.span(id) else { return };
        let mut collector = Collector::new();
        values.record(&mut collector);
        let mut extensions = span.extensions_mut();
        match extensions.get_mut::<SpanFields>() {
            Some(existing) => existing.0.extend(collector.fields),
            None => extensions.insert(SpanFields(collector.fields)),
        }
    }

    fn on_event(&self, event: &tracing::Event<'_>, ctx: Context<'_, S>) {
        let Some(state) = state() else { return };
        let mut collector = Collector::new();
        event.record(&mut collector);

        let metadata = event.metadata();
        let mut record = Record::new(
            &state.host,
            metadata.level().as_str(),
            metadata.target(),
            &collector.msg,
        );
        // The event's own fields first, so what a call site said outranks what
        // the span around it said.
        for name in LIFTED {
            if let Some(value) = collector.fields.remove(name) {
                record.set_lifted(name, as_text(&value));
            }
        }
        record.fields = collector.fields;

        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root().collect::<Vec<_>>().into_iter().rev() {
                // `from_root().rev()` is innermost first, so the first span to
                // name an id is the closest one, and `span` is that span's name.
                if record.span.is_none() {
                    record.span = Some(span.name().to_string());
                }
                let extensions = span.extensions();
                let Some(fields) = extensions.get::<SpanFields>() else {
                    continue;
                };
                for name in LIFTED {
                    if record.lifted(name).is_none() {
                        if let Some(value) = fields.0.get(name) {
                            record.set_lifted(name, as_text(value));
                        }
                    }
                }
            }
        }
        write(record);
    }
}

/// A field value as the text an id is.
///
/// `%id` arrives as a string and `?id` as a `Debug` string; a number arrives as
/// a number, and quoting it would make `thread=7` and `thread="7"` two threads.
fn as_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The layer, for a host that composes its own subscriber.
pub fn layer() -> BoiteLayer {
    BoiteLayer
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

    fn line(host: &str, ts: u64, seq: u64, msg: &str) -> String {
        let mut record = Record::new(host, "info", "test", msg);
        record.ts = ts;
        record.seq = seq;
        serde_json::to_string(&record).unwrap()
    }

    /// The bound the desktop's log never had on its rotations: it kept one
    /// previous file and the current one, so a burst of writes lost everything
    /// but the last 8 MB. Two are kept now, and the third is dropped rather
    /// than left to accumulate.
    #[test]
    fn a_roll_over_keeps_two_previous_files_and_no_more() {
        let dir = scratch("rotate");
        let big = "z".repeat(4096);
        let mut wrote = 0;
        // Three roll-overs, so a fourth generation would exist if anything kept
        // one.
        while !file_for(&dir, "desktop", 2).exists() {
            append_line(&dir, "desktop", &big).unwrap();
            wrote += 1;
            assert!(wrote < 20_000, "the file never rolled over twice");
        }
        append_line(&dir, "desktop", &big).unwrap();

        assert!(file_for(&dir, "desktop", 0).exists());
        assert!(file_for(&dir, "desktop", 1).exists());
        assert!(file_for(&dir, "desktop", 2).exists());
        assert!(
            !file_for(&dir, "desktop", 3).exists(),
            "a third rotation survived"
        );
        // And what rolled over is a move, not a truncation: the previous
        // generation still holds a full file.
        assert!(file_for(&dir, "desktop", 1).metadata().unwrap().len() >= MAX_LOG_BYTES);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Paths and addresses are what makes a log unshareable, and this one is
    /// read by an agent that pastes what it finds.
    #[test]
    fn what_identifies_the_user_never_reaches_the_file() {
        assert_eq!(redact("mail me at someone@example.com"), "mail me at <email>");
        assert_eq!(
            redact("from first.last@sub.domain.org to a.b@c.dev"),
            "from <email> to <email>"
        );
        assert_eq!(redact("user@localhost said no"), "user@localhost said no");
        assert_eq!(redact("résumé from éric@exemple.fr"), "résumé from <email>");

        // And a field, not only the message: a path lands in `fields` far more
        // often than in a sentence.
        let mut record = Record::new("desktop", "info", "test", "ok");
        record
            .fields
            .insert("who".into(), Value::String("a.b@c.dev".into()));
        record.fields.insert("n".into(), Value::from(3));
        record.redact();
        assert_eq!(record.fields["who"], Value::String("<email>".into()));
        assert_eq!(record.fields["n"], Value::from(3));
    }

    /// The merge is the whole reason every host writes into one directory: a
    /// question about a thread is answered by what the desktop and the server
    /// each saw, in the order it happened.
    #[test]
    fn a_query_merges_two_hosts_on_one_clock_and_filters_by_thread() {
        let dir = scratch("merge");
        let mut desktop = String::new();
        let mut server = String::new();
        for (ts, text) in [(10u64, "desktop first"), (30, "desktop third")] {
            let mut record: Record = serde_json::from_str(&line("desktop", ts, ts, text)).unwrap();
            record.thread = Some("t1".into());
            desktop.push_str(&serde_json::to_string(&record).unwrap());
            desktop.push('\n');
        }
        for (ts, text, thread) in [(20u64, "server second", "t1"), (40, "server other", "t2")] {
            let mut record: Record = serde_json::from_str(&line("server", ts, ts, text)).unwrap();
            record.thread = Some(thread.into());
            server.push_str(&serde_json::to_string(&record).unwrap());
            server.push('\n');
        }
        fs::write(file_for(&dir, "desktop", 0), desktop).unwrap();
        fs::write(file_for(&dir, "server", 0), server).unwrap();

        let all = query_in(&dir, &Query::default());
        assert_eq!(
            all.iter().map(|r| r.msg.as_str()).collect::<Vec<_>>(),
            ["desktop first", "server second", "desktop third", "server other"],
            "the merge is on ts, not on which file was read first"
        );

        let one_thread = query_in(
            &dir,
            &Query {
                thread: Some("t1".into()),
                ..Query::default()
            },
        );
        assert_eq!(
            one_thread.iter().map(|r| r.msg.as_str()).collect::<Vec<_>>(),
            ["desktop first", "server second", "desktop third"]
        );

        let one_host = query_in(
            &dir,
            &Query {
                host: Some("server".into()),
                ..Query::default()
            },
        );
        assert_eq!(one_host.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A rotated file is still the same host, and a query reads it: a question
    /// about ten minutes ago must not stop at the last roll-over.
    #[test]
    fn a_rotated_file_still_belongs_to_its_host() {
        let dir = scratch("rotated");
        fs::write(file_for(&dir, "server", 0), line("server", 20, 2, "now") + "\n").unwrap();
        fs::write(file_for(&dir, "server", 1), line("server", 10, 1, "before") + "\n").unwrap();
        let found = query_in(
            &dir,
            &Query {
                host: Some("server".into()),
                ..Query::default()
            },
        );
        assert_eq!(
            found.iter().map(|r| r.msg.as_str()).collect::<Vec<_>>(),
            ["before", "now"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The live half, in one test because [`init`] is once per process.
    ///
    /// Covers what only a running layer can show: an event inside a span comes
    /// out with the span's `thread` at the top level, the ring holds what was
    /// written, and a second `init` hands back the first one's directory rather
    /// than moving the log out from under whoever is already writing to it.
    #[test]
    fn the_layer_lifts_a_thread_from_its_span_and_the_ring_keeps_what_it_wrote() {
        let dir = scratch("live");
        let handle = init(LogConfig {
            dir: dir.clone(),
            host: "desktop".into(),
            extra_stderr: false,
        })
        .expect("the log installs");
        assert_eq!(handle.host(), "desktop");

        let span = tracing::info_span!("bus.call", method = "git.status", thread = "t-42");
        span.in_scope(|| {
            tracing::warn!(pid = 7u64, "pty.spawned");
        });
        // An event that names a thread itself outranks the span around it.
        tracing::info!(thread = "t-99", "webview.said");

        let seen = tail(50, None, None);
        let spawned = seen
            .iter()
            .find(|r| r.msg == "pty.spawned")
            .expect("the ring kept it");
        assert_eq!(spawned.thread.as_deref(), Some("t-42"), "lifted from the span");
        assert_eq!(spawned.span.as_deref(), Some("bus.call"));
        assert_eq!(spawned.level, "warn");
        assert_eq!(spawned.fields["pid"], Value::from(7));
        // `method` stays a field: only the four ids are lifted.
        assert!(!spawned.fields.contains_key("method"));

        let said = seen.iter().find(|r| r.msg == "webview.said").unwrap();
        assert_eq!(said.thread.as_deref(), Some("t-99"));
        assert_eq!(said.span, None);

        // Filtering the ring by level leaves the warning and drops the info.
        let warnings = tail(50, Some("warn"), None);
        assert!(warnings.iter().all(|r| severity(&r.level) >= severity("warn")));
        assert!(warnings.iter().any(|r| r.msg == "pty.spawned"));

        // A record that says it came from the webview keeps that host and still
        // lands in this process's file.
        let mut from_webview = Record::new("webview", "error", "ui.boot", "the frame stalled");
        from_webview.thread = Some("t-42".into());
        write(from_webview);
        let merged = query_in(
            &dir,
            &Query {
                thread: Some("t-42".into()),
                ..Query::default()
            },
        );
        assert!(merged.iter().any(|r| r.host == "webview" && r.level == "error"));
        assert!(merged.iter().any(|r| r.msg == "pty.spawned"));

        // A second init is the first one's answer, not a second log.
        let again = init(LogConfig {
            dir: std::env::temp_dir().join("boite-log-elsewhere"),
            host: "server".into(),
            extra_stderr: false,
        })
        .expect("a second init is a no-op");
        assert_eq!(again.dir(), dir.as_path());
        assert_eq!(again.host(), "desktop");

        // The filter is changeable, and a directive that is not one is refused
        // rather than silently ignored.
        assert!(set_level("warn,boite_core=debug").is_ok());
        assert!(level().contains("boite_core"));
        assert!(set_level("=== not a filter ===").is_err());
        assert!(set_level(&default_directives()).is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    /// A level filter is "this and worse", never "exactly this": the question
    /// an agent asks is "what went wrong", and an error is not a warning.
    #[test]
    fn a_level_filter_answers_that_level_and_worse() {
        assert!(severity("error") > severity("warn"));
        assert!(severity("warn") > severity("info"));
        assert!(severity("info") > severity("debug"));
        // An unknown word reads as info rather than dropping the record out of
        // every filtered read.
        assert_eq!(severity("shouting"), severity("info"));
    }
}
