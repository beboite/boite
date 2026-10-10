//! The shell's diagnostic log: `<dataDir>/logs/shell.{0..3}.ndjson`, one JSON
//! record per line in the format the core writes (`.agents/logs-overhaul.md`
//! names the fields). A caller only builds a record and hands it to a bounded
//! queue: a background thread does every disk write, so the main thread never
//! waits on a slow disk. A full queue drops the record and counts it, and the
//! next line written says how many were lost. Nothing here may panic: it runs
//! inside the panic hook and on the main thread.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};

/// The size a live file may reach before it rotates.
pub(crate) const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// `shell.0.ndjson` is live, `shell.3.ndjson` the oldest kept.
pub(crate) const FILES: usize = 4;
/// Records waiting for the writer. A burst larger than this is a bug worth one
/// line saying how much was lost, not a reason to stall the window.
const QUEUE: usize = 1024;
const MAX_MESSAGE_CHARS: usize = 4096;
const MAX_DATA_KEYS: usize = 16;
const MAX_KEY_CHARS: usize = 40;
const MAX_STRING_CHARS: usize = 300;
const STEM: &str = "shell";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Level { Debug, Info, Warn, Error }

/// One record before it is numbered and written. Source and event are static:
/// every call site names them literally, so queueing one costs no copy.
struct Pending {
    seq: u64,
    at: u64,
    level: Level,
    source: &'static str,
    event: &'static str,
    message: String,
    duration_ms: Option<u64>,
    data: Value,
}

#[derive(Serialize)]
struct Line<'a> {
    id: String,
    #[serde(rename = "runId")]
    run_id: &'a str,
    at: u64,
    level: Level,
    origin: &'static str,
    source: &'static str,
    event: &'static str,
    message: String,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Map::is_empty")]
    data: Map<String, Value>,
}

enum Message {
    Record(Pending),
    /// Answered once everything queued before it is on disk.
    Flush(SyncSender<()>),
}

struct Shared {
    run_id: String,
    seq: AtomicU64,
    dropped: AtomicU64,
}

impl Shared {
    fn next(&self) -> u64 { self.seq.fetch_add(1, Ordering::Relaxed) + 1 }
}

pub(crate) struct Logger {
    shared: Arc<Shared>,
    sender: SyncSender<Message>,
}

impl Logger {
    fn record(&self, level: Level, source: &'static str, event: &'static str, message: String, duration_ms: Option<u64>, data: Value) {
        let pending = Pending { seq: self.shared.next(), at: unix_ms(), level, source, event, message, duration_ms, data };
        match self.sender.try_send(Message::Record(pending)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => { self.shared.dropped.fetch_add(1, Ordering::Relaxed); }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    /// Waits until what was queued so far is written, for `patience` at most.
    fn flush(&self, patience: Duration) -> bool {
        let deadline = Instant::now() + patience;
        let (reply, answered) = mpsc::sync_channel(1);
        let mut message = Message::Flush(reply);
        loop {
            match self.sender.try_send(message) {
                Ok(()) => break,
                Err(TrySendError::Full(back)) if Instant::now() < deadline => {
                    message = back;
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(_) => return false,
            }
        }
        answered.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_ok()
    }
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

/// A version 4 UUID from the standard library's per-process random keys:
/// the shell needs one id per run, not a cryptographic source.
fn run_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut bytes = [0u8; 16];
    for (index, chunk) in bytes.chunks_mut(8).enumerate() {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(unix_ms());
        hasher.write_u32(std::process::id());
        hasher.write_usize(index);
        chunk.copy_from_slice(&hasher.finish().to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn truncate(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((end, _)) => text[..end].to_string(),
        None => text.to_string(),
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_KEY_CHARS
        && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

/// Scalars only, under the spec's bounds. A key that breaks a rule is left
/// out rather than renamed, so a reader never sees a key nobody wrote.
fn bounded_data(data: Value) -> Map<String, Value> {
    let Value::Object(object) = data else { return Map::new() };
    let mut kept = Map::new();
    for (key, value) in object {
        if kept.len() == MAX_DATA_KEYS { break; }
        if !valid_key(&key) { continue; }
        let value = match value {
            Value::String(text) => Value::String(truncate(&text, MAX_STRING_CHARS)),
            Value::Number(_) | Value::Bool(_) | Value::Null => value,
            Value::Array(_) | Value::Object(_) => continue,
        };
        kept.insert(key, value);
    }
    kept
}

fn render(run_id: &str, pending: Pending) -> Option<String> {
    let line = Line {
        id: format!("{run_id}:{}", pending.seq),
        run_id,
        at: pending.at,
        level: pending.level,
        origin: "shell",
        source: pending.source,
        event: pending.event,
        message: truncate(&pending.message, MAX_MESSAGE_CHARS),
        duration_ms: pending.duration_ms,
        data: bounded_data(pending.data),
    };
    let mut text = serde_json::to_string(&line).ok()?;
    text.push('\n');
    Some(text)
}

/// The files on disk. Every error is swallowed: a log that cannot be written
/// must not take the shell down with it.
pub(crate) struct Writer {
    directory: PathBuf,
    limit: u64,
    file: Option<File>,
    size: u64,
}

impl Writer {
    pub(crate) fn open(directory: PathBuf, limit: u64) -> Self {
        create_private_dir(&directory);
        let mut writer = Self { directory, limit, file: None, size: 0 };
        writer.reopen();
        writer.isolate_partial_line();
        writer
    }

    fn path(&self, index: usize) -> PathBuf { self.directory.join(format!("{STEM}.{index}.ndjson")) }

    fn reopen(&mut self) {
        let path = self.path(0);
        self.file = open_private(&path);
        self.size = self.file.as_ref().and_then(|file| file.metadata().ok()).map(|meta| meta.len()).unwrap_or(0);
    }

    /// A process killed mid-write leaves half a line: it gets its own line so
    /// the first record of this run still parses.
    fn isolate_partial_line(&mut self) {
        if self.size == 0 { return; }
        let Some(file) = self.file.as_mut() else { return };
        let mut last = [0u8; 1];
        let ended = file.seek(SeekFrom::End(-1)).is_ok() && file.read_exact(&mut last).is_ok() && last[0] == b'\n';
        if !ended && file.write_all(b"\n").is_ok() { self.size += 1; }
    }

    fn rotate(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(self.path(FILES - 1));
        for index in (0..FILES - 1).rev() {
            let _ = std::fs::rename(self.path(index), self.path(index + 1));
        }
        self.reopen();
    }

    pub(crate) fn write_line(&mut self, line: &str) {
        let length = line.len() as u64;
        if self.file.is_none() { self.reopen(); }
        if self.size > 0 && self.size + length > self.limit { self.rotate(); }
        let Some(file) = self.file.as_mut() else { return };
        if file.write_all(line.as_bytes()).is_ok() { self.size += length; }
        // A failed write may have left part of the line: start clean next time.
        else { self.file = None; }
    }
}

#[cfg(unix)]
fn create_private_dir(directory: &Path) {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(directory);
    let _ = std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn create_private_dir(directory: &Path) {
    let _ = std::fs::create_dir_all(directory);
}

fn open_private(path: &Path) -> Option<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let file = options.open(path).ok()?;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        Some(file)
    }
    #[cfg(not(unix))]
    { options.open(path).ok() }
}

fn channel(capacity: usize) -> (Logger, Receiver<Message>, Arc<Shared>) {
    let shared = Arc::new(Shared { run_id: run_id(), seq: AtomicU64::new(0), dropped: AtomicU64::new(0) });
    let (sender, receiver) = mpsc::sync_channel(capacity);
    (Logger { shared: shared.clone(), sender }, receiver, shared)
}

/// The writer thread's loop, until every sender is gone.
fn serve(receiver: Receiver<Message>, mut writer: Writer, shared: Arc<Shared>) {
    while let Ok(message) = receiver.recv() {
        match message {
            Message::Record(pending) => {
                if let Some(line) = render(&shared.run_id, pending) { writer.write_line(&line); }
            }
            Message::Flush(reply) => { let _ = reply.try_send(()); }
        }
        let dropped = shared.dropped.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            let pending = Pending {
                seq: shared.next(), at: unix_ms(), level: Level::Warn, source: "log", event: "shell.log.dropped",
                message: format!("{dropped} shell log records were dropped because the writer queue of {QUEUE} was full"),
                duration_ms: None, data: serde_json::json!({ "count": dropped }),
            };
            if let Some(line) = render(&shared.run_id, pending) { writer.write_line(&line); }
        }
    }
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// Starts the writer for `<dataDir>/logs`. Called once, as early as the data
/// directory is known; records before it, and in a process that could not
/// start the thread, go nowhere.
pub(crate) fn init(data_dir: &Path) {
    if LOGGER.get().is_some() { return; }
    let (logger, receiver, shared) = channel(QUEUE);
    let directory = data_dir.join("logs");
    let started = std::thread::Builder::new().name("shell-log".into()).spawn(move || {
        serve(receiver, Writer::open(directory, MAX_FILE_BYTES), shared);
    });
    if started.is_ok() { let _ = LOGGER.set(logger); }
}

/// Writes what is queued, for `patience` at most. Used on exit and in the panic hook.
pub(crate) fn flush(patience: Duration) -> bool { LOGGER.get().is_some_and(|logger| logger.flush(patience)) }

pub(crate) fn log(level: Level, source: &'static str, event: &'static str, message: impl Into<String>, duration_ms: Option<u64>, data: Value) {
    if let Some(logger) = LOGGER.get() { logger.record(level, source, event, message.into(), duration_ms, data); }
}

pub(crate) fn debug(source: &'static str, event: &'static str, message: impl Into<String>, data: Value) { log(Level::Debug, source, event, message, None, data); }
pub(crate) fn info(source: &'static str, event: &'static str, message: impl Into<String>, data: Value) { log(Level::Info, source, event, message, None, data); }
pub(crate) fn warn(source: &'static str, event: &'static str, message: impl Into<String>, data: Value) { log(Level::Warn, source, event, message, None, data); }
pub(crate) fn error(source: &'static str, event: &'static str, message: impl Into<String>, data: Value) { log(Level::Error, source, event, message, None, data); }

/// A record with a top-level `durationMs`.
pub(crate) fn timed(level: Level, source: &'static str, event: &'static str, message: impl Into<String>, duration: Duration, data: Value) {
    log(level, source, event, message, Some(duration.as_millis() as u64), data);
}

/// Seconds with one decimal, the unit a message reads in.
pub(crate) fn seconds(duration: Duration) -> String { format!("{:.1} s", duration.as_secs_f64()) }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("boite-shell-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        directory
    }

    fn lines(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path).unwrap_or_default().lines()
            .map(|line| serde_json::from_str(line).unwrap_or_else(|error| panic!("{line:?}: {error}"))).collect()
    }

    fn drain(logger: Logger, receiver: Receiver<Message>, shared: Arc<Shared>, directory: &Path, limit: u64) {
        drop(logger);
        serve(receiver, Writer::open(directory.to_path_buf(), limit), shared);
    }

    #[test]
    fn a_record_carries_the_shared_fields_in_one_json_line() {
        let directory = temp("format");
        let (logger, receiver, shared) = channel(8);
        let run = shared.run_id.clone();
        logger.record(Level::Warn, "window", "shell.main-thread.recovered", "main thread answered again after 6.2 s".into(),
            Some(6200), json!({ "command": "notify", "hung": false }));
        logger.record(Level::Info, "core", "shell.core.ready", "ready".into(), None, json!({}));
        drain(logger, receiver, shared, &directory, MAX_FILE_BYTES);
        let records = lines(&directory.join("shell.0.ndjson"));
        assert_eq!(records.len(), 2);
        let first = &records[0];
        assert_eq!(first["id"], format!("{run}:1"));
        assert_eq!(first["runId"], run);
        assert_eq!(first["level"], "warn");
        assert_eq!(first["origin"], "shell");
        assert_eq!(first["source"], "window");
        assert_eq!(first["event"], "shell.main-thread.recovered");
        assert_eq!(first["durationMs"], 6200);
        assert_eq!(first["data"], json!({ "command": "notify", "hung": false }));
        assert!(first["at"].as_u64().unwrap() > 1_700_000_000_000);
        assert_eq!(records[1]["id"], format!("{run}:2"));
        assert!(records[1].get("durationMs").is_none() && records[1].get("data").is_none(), "{}", records[1]);
        let id = run.as_bytes();
        assert_eq!(run.len(), 36);
        assert_eq!((id[8], id[13], id[14], id[18], id[23]), (b'-', b'-', b'4', b'-', b'-'));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn the_live_file_rotates_at_its_size_bound_and_keeps_four_files() {
        let directory = temp("rotation");
        let mut writer = Writer::open(directory.clone(), 100);
        let line = format!("{}\n", "x".repeat(39));
        for _ in 0..12 { writer.write_line(&line); }
        drop(writer);
        let sizes: Vec<_> = (0..6).map(|index| std::fs::metadata(directory.join(format!("shell.{index}.ndjson"))).map(|meta| meta.len()).ok()).collect();
        // Two 40-byte lines fit in 100 bytes; a third starts a new file.
        assert_eq!(sizes, vec![Some(80), Some(80), Some(80), Some(80), None, None]);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_partial_last_line_from_a_crash_gets_its_own_line() {
        let directory = temp("partial");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("shell.0.ndjson"), "{\"id\":\"old:1\"}\n{\"id\":\"old:2\",\"mess").unwrap();
        let (logger, receiver, shared) = channel(4);
        logger.record(Level::Info, "shell", "shell.start", "started".into(), None, json!({}));
        drain(logger, receiver, shared, &directory, MAX_FILE_BYTES);
        let text = std::fs::read_to_string(directory.join("shell.0.ndjson")).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 3, "{text}");
        assert_eq!(lines[1], "{\"id\":\"old:2\",\"mess");
        let last: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(last["event"], "shell.start");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_full_queue_drops_records_and_the_next_line_counts_them() {
        let directory = temp("overflow");
        let (logger, receiver, shared) = channel(3);
        for index in 0..8 {
            logger.record(Level::Debug, "rpc", "shell.command.slow", format!("record {index}"), None, json!({}));
        }
        assert_eq!(shared.dropped.load(Ordering::Relaxed), 5);
        drain(logger, receiver, shared, &directory, MAX_FILE_BYTES);
        let records = lines(&directory.join("shell.0.ndjson"));
        let events: Vec<_> = records.iter().map(|record| record["event"].as_str().unwrap().to_string()).collect();
        assert_eq!(events, ["shell.command.slow", "shell.log.dropped", "shell.command.slow", "shell.command.slow"]);
        assert_eq!(records[1]["level"], "warn");
        assert_eq!(records[1]["data"]["count"], 5);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn data_keeps_sixteen_valid_scalar_keys_with_bounded_strings() {
        let mut object = Map::new();
        object.insert("long".into(), json!("é".repeat(400)));
        object.insert("bad key".into(), json!(1));
        object.insert("k".repeat(41), json!(1));
        object.insert("nested".into(), json!({ "a": 1 }));
        object.insert("list".into(), json!([1]));
        object.insert("flag".into(), json!(true));
        // serde_json's map iterates in key order: these sort before the n keys the cut drops.
        object.insert("a_none".into(), Value::Null);
        for index in 0..30 { object.insert(format!("n{index:02}"), json!(index)); }
        let kept = bounded_data(Value::Object(object));
        assert_eq!(kept.len(), MAX_DATA_KEYS);
        assert_eq!(kept["long"].as_str().unwrap().chars().count(), MAX_STRING_CHARS);
        assert_eq!(kept["flag"], true);
        assert!(kept["a_none"].is_null());
        assert!(kept.contains_key("n12") && !kept.contains_key("n13"), "{kept:?}");
        for missing in ["bad key", "nested", "list"] { assert!(!kept.contains_key(missing), "{missing}"); }
        assert!(!kept.contains_key(&"k".repeat(41)));
        assert!(bounded_data(json!("not an object")).is_empty());
        let message = render("run", Pending { seq: 1, at: 0, level: Level::Error, source: "s", event: "e",
            message: "m".repeat(5000), duration_ms: None, data: json!({}) }).unwrap();
        let record: Value = serde_json::from_str(&message).unwrap();
        assert_eq!(record["message"].as_str().unwrap().len(), MAX_MESSAGE_CHARS);
    }

    #[cfg(unix)]
    #[test]
    fn the_directory_and_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = temp("modes");
        let mut writer = Writer::open(directory.clone(), MAX_FILE_BYTES);
        writer.write_line("{}\n");
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&directory), 0o700);
        assert_eq!(mode(&directory.join("shell.0.ndjson")), 0o600);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_flush_answers_once_the_queue_is_written() {
        let directory = temp("flush");
        let (logger, receiver, shared) = channel(4);
        let target = directory.clone();
        let worker = std::thread::spawn(move || serve(receiver, Writer::open(target, MAX_FILE_BYTES), shared));
        logger.record(Level::Info, "shell", "shell.exit", "exiting".into(), None, json!({}));
        assert!(logger.flush(Duration::from_secs(5)));
        assert_eq!(lines(&directory.join("shell.0.ndjson")).len(), 1);
        drop(logger);
        worker.join().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
