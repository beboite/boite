//! What the agents actually spent, read back out of their own transcripts.
//!
//! Nothing in Boite counts tokens: it launches a CLI in a PTY and the CLI keeps
//! its own record. Two of them keep one this can read — claude writes a
//! `usage` block on every assistant line of `~/.claude/projects/<cwd>/*.jsonl`,
//! and codex emits `token_count` events into `~/.codex/sessions/**/*.jsonl`.
//! The rest either keep no per-turn accounting or bury it in a schema that is
//! not documented anywhere, and a number invented from one of those is worse
//! than an absent card.
//!
//! Days are bucketed by the UTC date the transcript itself carries, taken as
//! the first ten characters of its ISO timestamp. Converting to local time
//! would mean a calendar and a timezone database for a heat map whose cells are
//! a day wide; the boundary moves by hours, and no cell changes colour for it.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// One model's share, split the way the two stores split it. Cache reads are
/// kept apart from input rather than folded into it: on a long agent session
/// they are most of the volume and none of the price, so a single "input"
/// number would say the run cost twenty times what it did.
#[derive(Serialize, Clone, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// The agent's icon key — `claude` or `codex` — so the UI can draw the row
    /// with the same brand icon the thread has.
    pub provider: String,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_write: i64,
    pub cache_read: i64,
    pub total: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// `YYYY-MM-DD`, UTC.
    pub day: String,
    pub total: i64,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// Heaviest first.
    pub models: Vec<ModelUsage>,
    /// Ascending. Only days something was spent on appear; the calendar draws
    /// the empty ones itself rather than being sent a year of zeroes.
    pub days: Vec<DayUsage>,
    /// Transcripts that contributed something.
    pub sessions: usize,
    /// Stores that are not on this machine at all, by icon key. The difference
    /// between "this agent spent nothing here" and "this agent was never
    /// installed" is the whole reading of an empty card.
    pub missing: Vec<String>,
}

const MILLIS_PER_DAY: i64 = 86_400_000;
/// Enough that a returning visit is free, small enough that the map cannot
/// become the reason the app holds memory. Dropped whole when exceeded: this
/// is a scan accelerator, and rebuilding it costs one slow refresh.
const CACHE_LIMIT: usize = 4096;

/// What one transcript is worth, in the shape the report needs. Cached against
/// the file's size and mtime, so a session that is still being written is the
/// only one ever re-read.
#[derive(Clone, Default)]
struct FileUsage {
    /// (provider, model) -> totals.
    models: Vec<((String, String), ModelUsage)>,
    days: Vec<(String, i64)>,
    counted: bool,
}

struct CacheEntry {
    len: u64,
    modified_ms: i64,
    usage: FileUsage,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ms_since_epoch(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Claude's own encoding of a working directory into a folder name.
fn encode_claude_project_dir(p: &str) -> String {
    p.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .to_lowercase()
}

/// The UTC day an ISO timestamp falls on, or None when it is not one.
fn iso_day(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.len() < 10 {
        return None;
    }
    let day = &s[..10];
    let b = day.as_bytes();
    let digits = |i: usize| b[i].is_ascii_digit();
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    if !(digits(0) && digits(1) && digits(2) && digits(3) && digits(5) && digits(6) && digits(8) && digits(9))
    {
        return None;
    }
    Some(day.to_string())
}

/// Accumulates one run's worth of files, so the two stores share the merge.
#[derive(Default)]
struct Accumulator {
    models: HashMap<(String, String), ModelUsage>,
    days: HashMap<String, i64>,
    sessions: usize,
}

impl Accumulator {
    fn absorb(&mut self, file: &FileUsage) {
        if !file.counted {
            return;
        }
        self.sessions += 1;
        for (key, add) in &file.models {
            let slot = self.models.entry(key.clone()).or_insert_with(|| ModelUsage {
                provider: key.0.clone(),
                model: key.1.clone(),
                ..Default::default()
            });
            slot.input += add.input;
            slot.output += add.output;
            slot.cache_write += add.cache_write;
            slot.cache_read += add.cache_read;
            slot.total += add.total;
        }
        for (day, total) in &file.days {
            *self.days.entry(day.clone()).or_insert(0) += total;
        }
    }

    fn finish(self, missing: Vec<String>) -> UsageReport {
        let mut models: Vec<ModelUsage> = self.models.into_values().collect();
        models.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.model.cmp(&b.model)));
        let mut days: Vec<DayUsage> = self
            .days
            .into_iter()
            .map(|(day, total)| DayUsage { day, total })
            .collect();
        days.sort_by(|a, b| a.day.cmp(&b.day));
        UsageReport {
            models,
            days,
            sessions: self.sessions,
            missing,
        }
    }
}

/// Reads a transcript, or hands back what it was worth last time.
fn cached_file<F>(path: &Path, parse: F) -> Option<FileUsage>
where
    F: FnOnce(&Path) -> FileUsage,
{
    let meta = fs::metadata(path).ok()?;
    let len = meta.len();
    let modified_ms = meta.modified().map(ms_since_epoch).unwrap_or(0);
    {
        let map = cache().lock();
        if let Some(hit) = map.get(path) {
            if hit.len == len && hit.modified_ms == modified_ms {
                return Some(hit.usage.clone());
            }
        }
    }
    let usage = parse(path);
    let mut map = cache().lock();
    if map.len() >= CACHE_LIMIT {
        map.clear();
    }
    map.insert(
        path.to_path_buf(),
        CacheEntry {
            len,
            modified_ms,
            usage: usage.clone(),
        },
    );
    Some(usage)
}

fn add(file: &mut FileUsage, provider: &str, model: &str, day: Option<&str>, u: ModelUsage) {
    let total = u.input + u.output + u.cache_write + u.cache_read;
    if total == 0 {
        return;
    }
    file.counted = true;
    let key = (provider.to_string(), model.to_string());
    match file.models.iter_mut().find(|(k, _)| *k == key) {
        Some((_, slot)) => {
            slot.input += u.input;
            slot.output += u.output;
            slot.cache_write += u.cache_write;
            slot.cache_read += u.cache_read;
            slot.total += total;
        }
        None => file.models.push((
            key,
            ModelUsage {
                provider: provider.to_string(),
                model: model.to_string(),
                total,
                ..u
            },
        )),
    }
    if let Some(day) = day {
        match file.days.iter_mut().find(|(d, _)| d == day) {
            Some((_, slot)) => *slot += total,
            None => file.days.push((day.to_string(), total)),
        }
    }
}

// ---------------------------------------------------------------- claude

#[derive(Deserialize)]
struct ClaudeLine {
    timestamp: Option<String>,
    message: Option<ClaudeMessage>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize)]
struct ClaudeUsage {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_creation_input_tokens: Option<i64>,
    cache_read_input_tokens: Option<i64>,
}

/// One transcript. Assistant lines repeat while a message streams, all
/// carrying the same `message.id` and the same final usage block, so the id is
/// what keeps a single answer from being counted five times.
fn parse_claude_file(path: &Path) -> FileUsage {
    let mut out = FileUsage::default();
    let Ok(handle) = fs::File::open(path) else {
        return out;
    };
    let mut seen: HashSet<String> = HashSet::new();
    for line in BufReader::new(handle).lines().map_while(Result::ok) {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<ClaudeLine>(&line) else {
            continue;
        };
        let Some(message) = parsed.message else { continue };
        let Some(usage) = message.usage else { continue };
        if let Some(id) = &message.id {
            if !seen.insert(id.clone()) {
                continue;
            }
        }
        let day = parsed.timestamp.as_deref().and_then(iso_day);
        add(
            &mut out,
            "claude",
            message.model.as_deref().unwrap_or("claude"),
            day.as_deref(),
            ModelUsage {
                input: usage.input_tokens.unwrap_or(0),
                output: usage.output_tokens.unwrap_or(0),
                cache_write: usage.cache_creation_input_tokens.unwrap_or(0),
                cache_read: usage.cache_read_input_tokens.unwrap_or(0),
                ..Default::default()
            },
        );
    }
    out
}

// ----------------------------------------------------------------- codex

#[derive(Deserialize)]
struct CodexLine {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
struct CodexTokens {
    input_tokens: Option<i64>,
    cached_input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

/// Codex reports a running total on every turn and the turn's own delta beside
/// it. The delta is what gets summed: adding the totals would count the whole
/// session once per turn, which on a fifty-turn run is off by a factor of
/// fifty. `total_token_usage` is only read when there is no delta — older
/// rollouts have none — and then only the last one counts.
fn parse_codex_file(path: &Path) -> FileUsage {
    let mut out = FileUsage::default();
    let Ok(handle) = fs::File::open(path) else {
        return out;
    };
    let mut model = String::new();
    let mut fallback: Option<(String, CodexTokens)> = None;
    for line in BufReader::new(handle).lines().map_while(Result::ok) {
        let Ok(parsed) = serde_json::from_str::<CodexLine>(&line) else {
            continue;
        };
        let Some(payload) = parsed.payload else { continue };
        if model.is_empty() {
            if let Some(found) = payload.get("model").and_then(|m| m.as_str()) {
                model = found.to_string();
            }
        }
        if parsed.kind.as_deref() == Some("session_meta") {
            continue;
        }
        if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") {
            continue;
        }
        let day = parsed.timestamp.as_deref().and_then(iso_day);
        let info = payload.get("info").unwrap_or(&payload);
        if let Some(last) = info.get("last_token_usage") {
            let t: CodexTokens = serde_json::from_value(last.clone()).unwrap_or_default();
            push_codex(&mut out, &model, day.as_deref(), t);
        } else if let Some(total) = info.get("total_token_usage") {
            let t: CodexTokens = serde_json::from_value(total.clone()).unwrap_or_default();
            fallback = Some((day.unwrap_or_default(), t));
        }
    }
    if let Some((day, t)) = fallback {
        push_codex(
            &mut out,
            &model,
            if day.is_empty() { None } else { Some(&day) },
            t,
        );
    }
    out
}

fn push_codex(out: &mut FileUsage, model: &str, day: Option<&str>, t: CodexTokens) {
    // Codex counts cached input inside `input_tokens`; splitting it back out
    // keeps the row comparable with claude's, where the two never overlap.
    let cached = t.cached_input_tokens.unwrap_or(0);
    let input = (t.input_tokens.unwrap_or(0) - cached).max(0);
    add(
        out,
        "codex",
        if model.is_empty() { "codex" } else { model },
        day,
        ModelUsage {
            input,
            output: t.output_tokens.unwrap_or(0),
            cache_read: cached,
            ..Default::default()
        },
    );
}

// ---------------------------------------------------------------- walking

fn collect_jsonl(root: &Path, out: &mut Vec<(PathBuf, i64)>, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            collect_jsonl(&entry.path(), out, depth + 1);
            continue;
        }
        let path = entry.path();
        if path.extension() != Some(OsStr::new("jsonl")) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(ms_since_epoch)
            .unwrap_or(0);
        out.push((path, modified));
    }
}

fn codex_session_cwd(path: &Path) -> Option<String> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().map_while(Result::ok).take(10) {
        if !line.contains("session_meta") {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        return value
            .get("payload")?
            .get("cwd")?
            .as_str()
            .map(|c| normalize(c));
    }
    None
}

/// Every token the agents spent in these directories, over the last `days`.
///
/// The caller passes the directories rather than a project: since worktree
/// isolation a project's threads run in folders that are not under it, and an
/// agent's store keys on the directory it ran in. Missing one means the card
/// under-reports without ever saying so.
///
/// A transcript is counted once per run even when it exists twice on disk:
/// moving a thread between projects copies the file into the destination, and
/// both copies are inside this project when the move was between one of its
/// worktrees and its own folder.
pub fn collect_usage_blocking(cwds: Vec<String>, days: u32) -> UsageReport {
    let mut acc = Accumulator::default();
    let mut missing = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return acc.finish(vec!["claude".into(), "codex".into()]);
    };
    let cutoff = now_ms() - (days.max(1) as i64) * MILLIS_PER_DAY;
    let targets: HashSet<String> = cwds.iter().map(|c| normalize(c)).collect();
    let mut seen_sessions: HashSet<String> = HashSet::new();

    let claude_root = home.join(".claude").join("projects");
    if claude_root.is_dir() {
        let encoded: HashSet<String> = targets.iter().map(|c| encode_claude_project_dir(c)).collect();
        for entry in fs::read_dir(&claude_root).into_iter().flatten().flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if !encoded.contains(&entry.file_name().to_string_lossy().to_lowercase()) {
                continue;
            }
            // Depth 6 is the recursion limit, so starting there reads this
            // folder and nothing under it. Claude's project folders are flat.
            let mut files = Vec::new();
            collect_jsonl(&entry.path(), &mut files, 6);
            for (path, modified) in files {
                if modified < cutoff {
                    continue;
                }
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned());
                if let Some(stem) = stem {
                    if !seen_sessions.insert(format!("claude:{stem}")) {
                        continue;
                    }
                }
                if let Some(usage) = cached_file(&path, parse_claude_file) {
                    acc.absorb(&usage);
                }
            }
        }
    } else {
        missing.push("claude".to_string());
    }

    let codex_root = home.join(".codex").join("sessions");
    if codex_root.is_dir() {
        let mut files = Vec::new();
        collect_jsonl(&codex_root, &mut files, 0);
        for (path, modified) in files {
            if modified < cutoff {
                continue;
            }
            // The cwd is inside the file, so unlike claude there is no path to
            // filter on first; the head is read for every candidate and the
            // rest only for the ones that match.
            let Some(cwd) = codex_session_cwd(&path) else {
                continue;
            };
            if !targets.contains(&cwd) {
                continue;
            }
            if let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) {
                if !seen_sessions.insert(format!("codex:{stem}")) {
                    continue;
                }
            }
            if let Some(usage) = cached_file(&path, parse_codex_file) {
                acc.absorb(&usage);
            }
        }
    } else {
        missing.push("codex".to_string());
    }

    acc.finish(missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(name: &str, lines: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("boite-usage-test-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.jsonl"));
        let mut f = fs::File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        path
    }

    /// The four counters stay apart, and the day comes off the line's own
    /// timestamp rather than off the file.
    #[test]
    fn a_claude_turn_is_split_four_ways() {
        let path = write(
            "claude-basic",
            &[r#"{"type":"assistant","timestamp":"2026-07-28T10:00:00.000Z","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":30,"cache_read_input_tokens":40}}}"#],
        );
        let usage = parse_claude_file(&path);
        let (_, m) = &usage.models[0];
        assert_eq!((m.input, m.output, m.cache_write, m.cache_read), (10, 20, 30, 40));
        assert_eq!(m.total, 100);
        assert_eq!(usage.days, vec![("2026-07-28".to_string(), 100)]);
    }

    /// A streaming answer writes the same line repeatedly with the same id and
    /// the same final usage block. Counted once each, a single reply read as
    /// three replies.
    #[test]
    fn a_streamed_answer_is_counted_once() {
        let line = r#"{"timestamp":"2026-07-28T10:00:00.000Z","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":5,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#;
        let path = write("claude-stream", &[line, line, line]);
        let usage = parse_claude_file(&path);
        assert_eq!(usage.models[0].1.total, 5);
    }

    /// Codex reports the running total beside the turn's delta. Summing the
    /// totals counts the whole session once per turn.
    #[test]
    fn codex_sums_the_delta_not_the_running_total() {
        let path = write(
            "codex-delta",
            &[
                r#"{"timestamp":"2026-07-28T09:00:00.000Z","type":"session_meta","payload":{"id":"s","cwd":"/w","model":"gpt-5-codex"}}"#,
                r#"{"timestamp":"2026-07-28T09:01:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}"#,
                r#"{"timestamp":"2026-07-28T09:02:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":25},"last_token_usage":{"input_tokens":200,"cached_input_tokens":100,"output_tokens":15}}}}"#,
            ],
        );
        let usage = parse_codex_file(&path);
        let (key, m) = &usage.models[0];
        assert_eq!(key.1, "gpt-5-codex");
        // Turn one: 100 input. Turn two: 200 input of which 100 cached.
        assert_eq!((m.input, m.output, m.cache_read), (200, 25, 100));
        assert_eq!(m.total, 325);
    }

    /// A rollout old enough to carry no delta still has to report something,
    /// and its running total is only worth reading once.
    #[test]
    fn an_older_rollout_falls_back_to_the_total() {
        let path = write(
            "codex-total",
            &[
                r#"{"timestamp":"2026-07-28T09:00:00.000Z","type":"session_meta","payload":{"id":"s","cwd":"/w"}}"#,
                r#"{"timestamp":"2026-07-28T09:01:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10}}}}"#,
                r#"{"timestamp":"2026-07-28T09:02:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":400,"output_tokens":40}}}}"#,
            ],
        );
        let usage = parse_codex_file(&path);
        assert_eq!(usage.models[0].1.total, 440);
    }

    /// The day is the transcript's own, and anything that is not a date is not
    /// one — a malformed line must not open a bucket called "undefined".
    #[test]
    fn only_a_real_date_becomes_a_bucket() {
        assert_eq!(iso_day("2026-07-28T10:00:00Z").as_deref(), Some("2026-07-28"));
        assert_eq!(iso_day("2026-07-28"), Some("2026-07-28".to_string()));
        for junk in ["", "yesterday", "2026/07/28", "20260728T10"] {
            assert_eq!(iso_day(junk), None, "{junk}");
        }
    }
}
