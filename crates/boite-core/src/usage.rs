//! What the agents actually spent, read back out of their own transcripts.
//!
//! Nothing in Boite counts tokens: it launches a CLI in a PTY and the CLI keeps
//! its own record. Three of them keep one this can read — claude writes a
//! `usage` block on every assistant line of `~/.claude/projects/<cwd>/*.jsonl`,
//! codex emits `token_count` events into `~/.codex/sessions/**/*.jsonl`, and
//! grok writes a `usage` object on each `turn_completed` line of
//! `~/.grok/sessions/<cwd>/<id>/updates.jsonl`. The rest either keep no
//! per-turn accounting or bury it in a schema that is not documented anywhere,
//! and a number invented from one of those is worse than an absent card.
//!
//! Days are bucketed by the UTC date the transcript itself carries, taken as
//! the first ten characters of its ISO timestamp. Converting to local time
//! would mean a calendar and a timezone database for a heat map whose cells are
//! a day wide; the boundary moves by hours, and no cell changes colour for it.
//!
//! # What makes a scan cheap
//!
//! A visit to a project page walks a year of three stores, so the shape of the
//! walk is the whole cost, and three things decide it:
//!
//! - **The cache survives.** It is keyed on each file's size and mtime, so only
//!   a session still being written is ever re-read. It used to be emptied whole
//!   the moment it held more entries than the limit, which on any machine with
//!   more than `CACHE_LIMIT` transcripts meant every scan re-read every file
//!   and then threw the answers away again. It drops the half nobody has asked
//!   for lately instead.
//! - **Codex's directory is read once per file, not once per scan.** Codex
//!   keeps the working directory *inside* the rollout, so there is nothing on
//!   the path to filter on and the head of every candidate has to be opened.
//!   That answer is now cached beside the numbers, so a machine with thousands
//!   of rollouts pays thousands of opens once rather than on every visit to
//!   every project.
//! - **The version stamp comes from the walk.** `read_dir` already knows each
//!   file's size and mtime; asking `fs::metadata` again was a second syscall
//!   per transcript per scan.
//!
//! On top of that the parsing runs a few files at a time ([`SCAN_THREADS`]),
//! because a transcript is a disk seek with a JSON parse on the end of it and
//! serially the two take turns idling.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::session::{grok_dir_name, grok_sessions_dir};

/// One model's share, split the way the two stores split it. Cache reads are
/// kept apart from input rather than folded into it: on a long agent session
/// they are most of the volume and none of the price, so a single "input"
/// number would say the run cost twenty times what it did.
#[derive(Serialize, Clone, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// The agent's icon key — `claude`, `codex` or `grok` — so the UI can draw
    /// the row with the same brand icon the thread has.
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
    /// The orchestrators' own share of the totals, split out by the session
    /// ids the workspace stamped on their threads. Zero when none match, which
    /// is also what a store whose ids this cannot see honestly reports.
    pub orchestrator_total: i64,
    /// How many of `sessions` belonged to an orchestrator thread.
    pub orchestrator_sessions: usize,
    /// Stores that are not on this machine at all, by icon key. The difference
    /// between "this agent spent nothing here" and "this agent was never
    /// installed" is the whole reading of an empty card.
    pub missing: Vec<String>,
}

const MILLIS_PER_DAY: i64 = 86_400_000;

/// How many transcripts the cache holds before it starts dropping any.
///
/// An entry is a path, four counters per model and one per day the session
/// touched, so a full map is single-digit megabytes — cheap next to re-reading
/// a year of JSONL. What matters far more than the number is that going over
/// it evicts rather than clears: see [`evict`].
const CACHE_LIMIT: usize = 16_384;

/// How many transcripts are read at once.
///
/// A small constant rather than the core count on purpose. This runs on the
/// machine somebody is working on, and the job is a queue of disk seeks with a
/// JSON parse on the end of each: four is already past the point where the disk
/// is what is left to wait for, and a thread per core would take the window's
/// own CPU to buy nothing.
const SCAN_THREADS: usize = 4;

/// What one transcript is worth, in the shape the report needs.
#[derive(Clone, Default)]
struct FileUsage {
    /// (provider, model) -> totals.
    models: Vec<((String, String), ModelUsage)>,
    days: Vec<(String, i64)>,
    counted: bool,
}

/// One transcript on disk, with the version stamp the directory walk already
/// carried. `read_dir` is told the size and the mtime as it enumerates, so
/// asking `fs::metadata` again downstream was one syscall per file per scan for
/// an answer already in hand.
#[derive(Clone)]
struct Candidate {
    path: PathBuf,
    len: u64,
    modified_ms: i64,
}

/// What is known about one version of one transcript.
///
/// Both fields are filled lazily and independently, which is the point: a codex
/// rollout belonging to another project costs its `cwd` and nothing else, and
/// stays cached at that price for every later scan that has to rule it out
/// again.
struct Entry {
    len: u64,
    modified_ms: i64,
    /// The scan clock the last reader stamped. Eviction reads this.
    used: u64,
    /// The directory the session recorded, for the store that keeps it inside
    /// the file rather than in the path. `Some(None)` is "looked, found none",
    /// which is an answer and must not be looked for a second time.
    cwd: Option<Option<String>>,
    /// Filled once something has actually asked for this file's numbers.
    usage: Option<Arc<FileUsage>>,
}

impl Entry {
    fn blank(c: &Candidate) -> Self {
        Self {
            len: c.len,
            modified_ms: c.modified_ms,
            used: 0,
            cwd: None,
            usage: None,
        }
    }

    fn is(&self, c: &Candidate) -> bool {
        self.len == c.len && self.modified_ms == c.modified_ms
    }
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Entry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Entry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A monotonic tick, so "least recently wanted" is an order rather than a
/// timestamp. A wall clock would tie every entry a single scan touched.
fn tick() -> u64 {
    static CLOCK: AtomicU64 = AtomicU64::new(0);
    CLOCK.fetch_add(1, Ordering::Relaxed) + 1
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

    fn total(&self) -> i64 {
        self.models.values().map(|m| m.total).sum()
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
            orchestrator_total: 0,
            orchestrator_sessions: 0,
            missing,
        }
    }
}

/// The session id a transcript answers to, the way each store names one.
///
/// Claude and codex name the file after the session; grok names the folder and
/// calls every transcript `updates`, so the folder is the id there.
fn session_key(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    if stem == "updates" {
        return path
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned());
    }
    Some(stem)
}

// ------------------------------------------------------------------ cache

/// Reads one field off this file's cache line, when there is a line for this
/// exact version of the file. Bumps the clock, because asking is what keeps an
/// entry alive.
fn cached<T>(c: &Candidate, read: impl Fn(&Entry) -> Option<T>) -> Option<T> {
    let mut map = cache().lock();
    let entry = map.get_mut(&c.path)?;
    if !entry.is(c) {
        return None;
    }
    entry.used = tick();
    read(entry)
}

/// Fills one field in, opening a line for the file or replacing the one that
/// described an older version of it.
fn remember(c: &Candidate, fill: impl FnOnce(&mut Entry)) {
    let mut map = cache().lock();
    let entry = map.entry(c.path.clone()).or_insert_with(|| Entry::blank(c));
    if !entry.is(c) {
        *entry = Entry::blank(c);
    }
    entry.used = tick();
    fill(entry);
    evict(&mut map);
}

/// Drops the half nobody has asked for lately, rather than the whole map.
///
/// Clearing it whole is what stopped this from being a cache at all: a machine
/// holding more transcripts than the limit emptied it on every single scan, so
/// every scan re-read every file and then threw the work away — the limit was
/// doing the exact opposite of its job, and the more history a machine had the
/// worse it got.
fn evict(map: &mut HashMap<PathBuf, Entry>) {
    if map.len() < CACHE_LIMIT {
        return;
    }
    let mut stamps: Vec<u64> = map.values().map(|e| e.used).collect();
    stamps.sort_unstable();
    let cut = stamps[stamps.len() / 2];
    map.retain(|_, e| e.used > cut);
}

/// This transcript's numbers, parsing it only if nothing already holds them.
fn cached_usage(c: &Candidate, parse: fn(&Path) -> FileUsage) -> Arc<FileUsage> {
    if let Some(hit) = cached(c, |e| e.usage.clone()) {
        return hit;
    }
    let made = Arc::new(parse(&c.path));
    remember(c, |e| e.usage = Some(made.clone()));
    made
}

/// The directory this codex rollout ran in, read from its head once per version
/// of the file. Every scan of every project used to pay this for every rollout
/// on the machine, which is the single most expensive thing this module did.
fn cached_cwd(c: &Candidate) -> Option<String> {
    if let Some(hit) = cached(c, |e| e.cwd.clone()) {
        return hit;
    }
    let read = codex_session_cwd(&c.path);
    remember(c, |e| e.cwd = Some(read.clone()));
    read
}

// --------------------------------------------------------------- scanning

/// Runs `work` over these files a few at a time, in no particular order.
///
/// Order does not matter because everything downstream of this sums, and not
/// caring is what lets a worker take the next file the moment it is free rather
/// than waiting on a chunk boundary — one huge transcript in a batch of small
/// ones is the normal case.
fn scan<T, F>(items: &[Candidate], work: F) -> Vec<T>
where
    T: Send,
    F: Fn(&Candidate) -> T + Sync,
{
    let width = SCAN_THREADS.min(items.len());
    if width <= 1 {
        return items.iter().map(work).collect();
    }
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..width)
            .map(|_| {
                let next = &next;
                let work = &work;
                scope.spawn(move || {
                    let mut mine = Vec::new();
                    while let Some(item) = items.get(next.fetch_add(1, Ordering::Relaxed)) {
                        mine.push(work(item));
                    }
                    mine
                })
            })
            .collect();
        // A worker that panicked has already said why on its way out. Losing
        // its share under-reports one scan, which the refresh button answers;
        // propagating it would take the window's command down with it.
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
}

/// Folds a batch of transcripts into the report, reading only the ones nothing
/// already holds.
///
/// Two passes on purpose. A warm batch is one hash lookup per file, and four
/// threads cost more than the lookups do: fanning out unconditionally made the
/// common case — a project reopened a minute after it was last read — measurably
/// slower than leaving it serial. Only the misses are worth a thread, and they
/// are the ones that touch the disk.
fn absorb_all(acc: &mut Accumulator, files: &[Candidate], parse: fn(&Path) -> FileUsage) {
    let mut cold: Vec<Candidate> = Vec::new();
    for c in files {
        match cached(c, |e| e.usage.clone()) {
            Some(usage) => acc.absorb(&usage),
            None => cold.push(c.clone()),
        }
    }
    for usage in scan(&cold, |c| cached_usage(c, parse)) {
        acc.absorb(&usage);
    }
}

/// The directory each of these rollouts ran in, split the same way: the ones
/// already known cost a lookup, and only a head that has never been read is
/// worth handing to a thread.
fn cwds_of(files: &[Candidate]) -> Vec<(Candidate, String)> {
    let mut out: Vec<(Candidate, String)> = Vec::new();
    let mut cold: Vec<Candidate> = Vec::new();
    for c in files {
        match cached(c, |e| e.cwd.clone()) {
            Some(Some(cwd)) => out.push((c.clone(), cwd)),
            // Looked at before and carrying no `session_meta`. An answer, and
            // not one worth asking the disk for a second time.
            Some(None) => {}
            None => cold.push(c.clone()),
        }
    }
    let read = scan(&cold, |c| cached_cwd(c).map(|cwd| (c.clone(), cwd)));
    out.extend(read.into_iter().flatten());
    out
}

/// The files worth opening: inside the window, and not a second copy of a
/// transcript already counted.
///
/// A transcript is counted once per run even when it exists twice on disk:
/// moving a thread between projects copies the file into the destination, and
/// both copies are inside this project when the move was between one of its
/// worktrees and its own folder.
fn shortlist(
    files: Vec<Candidate>,
    cutoff: i64,
    kind: &str,
    seen: &mut HashSet<String>,
) -> Vec<Candidate> {
    let mut out = Vec::with_capacity(files.len());
    for c in files {
        if c.modified_ms < cutoff {
            continue;
        }
        if let Some(stem) = c.path.file_stem().map(|s| s.to_string_lossy().into_owned()) {
            if !seen.insert(format!("{kind}:{stem}")) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

fn add(file: &mut FileUsage, provider: &str, model: &str, day: Option<&str>, u: ModelUsage) {
    let total = u.input + u.output + u.cache_write + u.cache_read;
    if total == 0 {
        return;
    }
    file.counted = true;
    // Matched on the strings rather than on a freshly built key: a transcript
    // is hundreds of assistant lines and all but the first few name a model
    // already in the list, so building the key first allocated two Strings per
    // line to throw both away.
    match file
        .models
        .iter_mut()
        .find(|((p, m), _)| p == provider && m == model)
    {
        Some((_, slot)) => {
            slot.input += u.input;
            slot.output += u.output;
            slot.cache_write += u.cache_write;
            slot.cache_read += u.cache_read;
            slot.total += total;
        }
        None => file.models.push((
            (provider.to_string(), model.to_string()),
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

/// Reads a transcript line by line into one buffer.
///
/// `BufRead::lines` hands back a fresh `String` per line, and a claude
/// transcript's lines carry whole tool results — an allocation the size of the
/// largest line, once per line, for a file most of whose lines are discarded on
/// a substring test. One buffer keeps its capacity across the file.
fn each_line(path: &Path, mut on_line: impl FnMut(&str)) {
    let Ok(handle) = fs::File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(handle);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => on_line(&line),
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
    let mut seen: HashSet<String> = HashSet::new();
    each_line(path, |line| {
        if !line.contains("\"usage\"") {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<ClaudeLine>(line) else {
            return;
        };
        let Some(message) = parsed.message else { return };
        let Some(usage) = message.usage else { return };
        if let Some(id) = message.id {
            if !seen.insert(id) {
                return;
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
    });
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
    let mut model = String::new();
    let mut fallback: Option<(String, CodexTokens)> = None;
    each_line(path, |line| {
        // Most of a rollout is prompts and tool output, and neither carries
        // either of the two things read here. Both tests are a substring scan;
        // what they skip is a whole `serde_json::Value` per line.
        if !line.contains("token_count") && !(model.is_empty() && line.contains("\"model\"")) {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<CodexLine>(line) else {
            return;
        };
        let Some(payload) = parsed.payload else { return };
        if model.is_empty() {
            if let Some(found) = payload.get("model").and_then(|m| m.as_str()) {
                model = found.to_string();
            }
        }
        if parsed.kind.as_deref() == Some("session_meta") {
            return;
        }
        if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") {
            return;
        }
        let day = parsed.timestamp.as_deref().and_then(iso_day);
        let info = payload.get("info").unwrap_or(&payload);
        // Deserialized off the borrowed value: `from_value` takes ownership, so
        // reaching it meant cloning the block back out of the payload first.
        if let Some(last) = info.get("last_token_usage") {
            let t = CodexTokens::deserialize(last).unwrap_or_default();
            push_codex(&mut out, &model, day.as_deref(), t);
        } else if let Some(total) = info.get("total_token_usage") {
            let t = CodexTokens::deserialize(total).unwrap_or_default();
            fallback = Some((day.unwrap_or_default(), t));
        }
    });
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

// ------------------------------------------------------------------ grok

#[derive(Deserialize)]
struct GrokLine {
    timestamp: Option<i64>,
    params: Option<GrokParams>,
}

#[derive(Deserialize)]
struct GrokParams {
    update: Option<GrokUpdate>,
}

#[derive(Deserialize)]
struct GrokUpdate {
    #[serde(rename = "sessionUpdate")]
    session_update: Option<String>,
    prompt_id: Option<String>,
    usage: Option<GrokUsage>,
}

#[derive(Deserialize, Default)]
struct GrokUsage {
    #[serde(rename = "inputTokens")]
    input_tokens: Option<i64>,
    #[serde(rename = "outputTokens")]
    output_tokens: Option<i64>,
    #[serde(rename = "cachedReadTokens")]
    cached_read_tokens: Option<i64>,
    #[serde(rename = "cacheCreationTokens")]
    cache_creation_tokens: Option<i64>,
    #[serde(rename = "modelUsage")]
    model_usage: Option<HashMap<String, GrokUsage>>,
}

/// One `turn_completed` is that turn's own spend, not a running total: a later
/// turn can be smaller than an earlier one. `inputTokens` includes cache
/// reads, the way Codex's `input_tokens` does, so they are split back out.
fn parse_grok_file(path: &Path) -> FileUsage {
    let mut out = FileUsage::default();
    let mut seen: HashSet<String> = HashSet::new();
    each_line(path, |line| {
        if !line.contains("turn_completed") {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<GrokLine>(line) else {
            return;
        };
        let Some(update) = parsed.params.and_then(|p| p.update) else {
            return;
        };
        if update.session_update.as_deref() != Some("turn_completed") {
            return;
        };
        let Some(usage) = update.usage else { return };
        if let Some(id) = update.prompt_id {
            if !seen.insert(id) {
                return;
            }
        }
        let day = parsed.timestamp.and_then(unix_day);
        if let Some(models) = usage.model_usage {
            for (model, u) in models {
                push_grok(&mut out, &model, day.as_deref(), &u);
            }
        } else {
            push_grok(&mut out, "grok", day.as_deref(), &usage);
        }
    });
    out
}

fn push_grok(out: &mut FileUsage, model: &str, day: Option<&str>, u: &GrokUsage) {
    let cached = u.cached_read_tokens.unwrap_or(0);
    let input = (u.input_tokens.unwrap_or(0) - cached).max(0);
    add(
        out,
        "grok",
        if model.is_empty() { "grok" } else { model },
        day,
        ModelUsage {
            input,
            output: u.output_tokens.unwrap_or(0),
            cache_write: u.cache_creation_tokens.unwrap_or(0),
            cache_read: cached,
            ..Default::default()
        },
    );
}

/// UTC calendar day of a unix timestamp in seconds.
fn unix_day(secs: i64) -> Option<String> {
    if secs < 0 {
        return None;
    }
    civil_from_unix_days(secs.div_euclid(86_400))
}

/// Howard Hinnant's `civil_from_days`, unix epoch as day 0.
fn civil_from_unix_days(days: i64) -> Option<String> {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    if !(0..=9999).contains(&y) {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
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

fn collect_jsonl(root: &Path, out: &mut Vec<Candidate>, depth: usize) {
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
        // A file whose metadata cannot be read cannot be opened either, and the
        // size and the mtime are this file's version: without both, nothing
        // downstream can tell a cached answer from a stale one.
        let Ok(meta) = entry.metadata() else { continue };
        out.push(Candidate {
            path,
            len: meta.len(),
            modified_ms: meta.modified().map(ms_since_epoch).unwrap_or(0),
        });
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
            .map(normalize);
    }
    None
}

/// Every token the agents spent in these directories, over the last `days`.
///
/// The caller passes the directories rather than a project: since worktree
/// isolation a project's threads run in folders that are not under it, and an
/// agent's store keys on the directory it ran in. Missing one means the card
/// under-reports without ever saying so.
/// `orchestrator_sessions` are the session ids the workspace stamped on its
/// orchestrator threads; transcripts answering to one are also summed apart,
/// so the card can show the conductor's share next to the workers'.
pub fn collect_usage_blocking(
    cwds: Vec<String>,
    days: u32,
    orchestrator_sessions: Vec<String>,
) -> UsageReport {
    let mut acc = Accumulator::default();
    let mut orch = Accumulator::default();
    let split: HashSet<String> = orchestrator_sessions.into_iter().collect();
    let mut missing = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return acc.finish(vec!["claude".into(), "codex".into(), "grok".into()]);
    };
    let cutoff = now_ms() - (days.max(1) as i64) * MILLIS_PER_DAY;
    let targets: HashSet<String> = cwds.iter().map(|c| normalize(c)).collect();
    let mut seen_sessions: HashSet<String> = HashSet::new();

    let claude_root = home.join(".claude").join("projects");
    if claude_root.is_dir() {
        // Claude encodes the working directory into the folder name, so the
        // filter is on the path and nothing outside this project is ever
        // opened.
        let encoded: HashSet<String> = targets.iter().map(|c| encode_claude_project_dir(c)).collect();
        let mut files = Vec::new();
        for entry in fs::read_dir(&claude_root).into_iter().flatten().flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if !kind.is_dir() {
                continue;
            }
            // A worktree's store is a link onto its project's
            // (`session::shared`), and the project's own folder is in `targets`
            // too, so every transcript under a link is already walked under its
            // real name. Reading it again is the same file parsed once per open
            // thread, and `shortlist` drops the repeats only after paying for
            // them. On Windows a junction reports itself as a directory, so
            // this is the test that sees it.
            if kind.is_symlink() {
                continue;
            }
            if !encoded.contains(&entry.file_name().to_string_lossy().to_lowercase()) {
                continue;
            }
            // Depth 6 is the recursion limit, so starting there reads this
            // folder and nothing under it. Claude's project folders are flat.
            collect_jsonl(&entry.path(), &mut files, 6);
        }
        let wanted = shortlist(files, cutoff, "claude", &mut seen_sessions);
        absorb_all(&mut acc, &wanted, parse_claude_file);
        absorb_split(&mut orch, &wanted, &split, parse_claude_file);
    } else {
        missing.push("claude".to_string());
    }

    let codex_root = home.join(".codex").join("sessions");
    if codex_root.is_dir() {
        let mut files = Vec::new();
        collect_jsonl(&codex_root, &mut files, 0);
        files.retain(|c| c.modified_ms >= cutoff);
        // The cwd is inside the file, so unlike claude there is no path to
        // filter on: the head of every rollout in the window has to be read at
        // least once. Once, and then held — `cached_cwd` keeps the answer
        // against the file's own version, so ruling a rollout out is free on
        // every later scan of every project.
        let mine: Vec<Candidate> = cwds_of(&files)
            .into_iter()
            .filter(|(_, cwd)| targets.contains(cwd))
            .map(|(c, _)| c)
            .collect();
        let wanted = shortlist(mine, cutoff, "codex", &mut seen_sessions);
        absorb_all(&mut acc, &wanted, parse_codex_file);
        absorb_split(&mut orch, &wanted, &split, parse_codex_file);
    } else {
        missing.push("codex".to_string());
    }

    if let Some(grok_root) = grok_sessions_dir() {
        if grok_root.is_dir() {
            let encoded: HashSet<String> = targets.iter().map(|c| grok_dir_name(c)).collect();
            let mut files = Vec::new();
            for entry in fs::read_dir(&grok_root).into_iter().flatten().flatten() {
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_symlink() {
                    continue;
                }
                if !kind.is_dir() {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let wanted = encoded.contains(name.as_ref())
                    || fs::read_to_string(entry.path().join(".cwd"))
                        .map(|c| targets.contains(&normalize(c.trim())))
                        .unwrap_or(false);
                if !wanted {
                    continue;
                }
                for session in fs::read_dir(entry.path()).into_iter().flatten().flatten() {
                    let Ok(kind) = session.file_type() else { continue };
                    if !kind.is_dir() {
                        continue;
                    }
                    let id = session.file_name().to_string_lossy().into_owned();
                    if !seen_sessions.insert(format!("grok:{id}")) {
                        continue;
                    }
                    let updates = session.path().join("updates.jsonl");
                    let Ok(meta) = fs::metadata(&updates) else { continue };
                    if !meta.is_file() || meta.modified().map(ms_since_epoch).unwrap_or(0) < cutoff
                    {
                        continue;
                    }
                    files.push(Candidate {
                        path: updates,
                        len: meta.len(),
                        modified_ms: meta.modified().map(ms_since_epoch).unwrap_or(0),
                    });
                }
            }
            absorb_all(&mut acc, &files, parse_grok_file);
            absorb_split(&mut orch, &files, &split, parse_grok_file);
        } else {
            missing.push("grok".to_string());
        }
    } else {
        missing.push("grok".to_string());
    }

    let mut report = acc.finish(missing);
    report.orchestrator_total = orch.total();
    report.orchestrator_sessions = orch.sessions;
    report
}

/// Folds only the transcripts whose session id the split set names. Runs after
/// [`absorb_all`] over the same batch, so every file it wants is a warm cache
/// hit, never a second parse.
fn absorb_split(
    acc: &mut Accumulator,
    files: &[Candidate],
    split: &HashSet<String>,
    parse: fn(&Path) -> FileUsage,
) {
    if split.is_empty() {
        return;
    }
    let mine: Vec<Candidate> = files
        .iter()
        .filter(|c| session_key(&c.path).is_some_and(|k| split.contains(&k)))
        .cloned()
        .collect();
    absorb_all(acc, &mine, parse);
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

    fn candidate(path: &Path) -> Candidate {
        let meta = fs::metadata(path).unwrap();
        Candidate {
            path: path.to_path_buf(),
            len: meta.len(),
            modified_ms: meta.modified().map(ms_since_epoch).unwrap_or(0),
        }
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

    /// Grok's `inputTokens` includes cache reads. A later turn can spend less
    /// than an earlier one, so each `turn_completed` is a delta.
    #[test]
    fn grok_splits_cache_out_of_input_and_sums_turns() {
        let turn = |id: &str, ts: i64, input: i64, output: i64, cached: i64| {
            serde_json::json!({
                "timestamp": ts,
                "params": {
                    "update": {
                        "sessionUpdate": "turn_completed",
                        "prompt_id": id,
                        "usage": {
                            "inputTokens": input,
                            "outputTokens": output,
                            "cachedReadTokens": cached,
                            "cacheCreationTokens": 0,
                            "modelUsage": {
                                "grok-4.6-build": {
                                    "inputTokens": input,
                                    "outputTokens": output,
                                    "cachedReadTokens": cached,
                                    "cacheCreationTokens": 0
                                }
                            }
                        }
                    }
                }
            })
            .to_string()
        };
        let a = turn("a", 1_786_992_246, 100, 10, 40);
        let b = turn("b", 1_786_992_246, 50, 5, 10);
        let path = write("grok-turns", &[&a, &b]);
        let usage = parse_grok_file(&path);
        let (key, m) = &usage.models[0];
        assert_eq!(key.1, "grok-4.6-build");
        assert_eq!((m.input, m.output, m.cache_read), (100, 15, 50));
        assert_eq!(m.total, 165);
        assert_eq!(usage.days, vec![("2026-08-17".to_string(), 165)]);
    }

    #[test]
    fn grok_unix_day_is_utc() {
        assert_eq!(unix_day(1_786_992_246).as_deref(), Some("2026-08-17"));
        assert_eq!(unix_day(0).as_deref(), Some("1970-01-01"));
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

    /// A second read of an unchanged file hands back the same allocation rather
    /// than a second parse, and rewriting the file drops it.
    ///
    /// The rewrite below is a byte longer than the original, which is not
    /// decoration. The key is the pair (size, mtime), and the two writes land
    /// within the same tick of a filesystem whose mtime is coarser than they
    /// are: an edit that kept the length read as the same version, the entry
    /// was handed back, and the assertion failed on a CI runner roughly one run
    /// in three while passing on every machine it was written on. A transcript
    /// in the wild is appended to, so growing is also what the case being
    /// tested actually looks like.
    #[test]
    fn an_unchanged_transcript_is_parsed_once() {
        let path = write(
            "cache-hit",
            &[r#"{"timestamp":"2026-07-28T10:00:00.000Z","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":7,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#],
        );
        let first = cached_usage(&candidate(&path), parse_claude_file);
        let second = cached_usage(&candidate(&path), parse_claude_file);
        assert!(Arc::ptr_eq(&first, &second), "second read re-parsed the file");

        let rewritten = write(
            "cache-hit",
            &[r#"{"timestamp":"2026-07-28T10:00:00.000Z","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":7,"output_tokens":90,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#],
        );
        let third = cached_usage(&candidate(&rewritten), parse_claude_file);
        assert!(!Arc::ptr_eq(&first, &third), "a rewritten file was not re-read");
        assert_eq!(third.models[0].1.total, 97);
    }

    /// Going over the limit drops the half nobody asked for, and keeps the
    /// half somebody did. Emptying it whole is what made a machine with more
    /// transcripts than the limit re-read every file on every scan.
    #[test]
    fn a_full_cache_evicts_rather_than_empties() {
        let mut map: HashMap<PathBuf, Entry> = HashMap::new();
        for i in 0..CACHE_LIMIT {
            let c = Candidate {
                path: PathBuf::from(format!("/tmp/t{i}.jsonl")),
                len: 1,
                modified_ms: 1,
            };
            let mut entry = Entry::blank(&c);
            entry.used = i as u64 + 1;
            map.insert(c.path, entry);
        }
        evict(&mut map);
        assert!(!map.is_empty(), "the map was emptied");
        assert!(map.len() < CACHE_LIMIT, "nothing was dropped");
        // The newest stamp survives, the oldest does not.
        assert!(map.contains_key(&PathBuf::from(format!("/tmp/t{}.jsonl", CACHE_LIMIT - 1))));
        assert!(!map.contains_key(&PathBuf::from("/tmp/t0.jsonl")));
    }

    /// The store keeps the working directory inside the rollout, so ruling one
    /// out costs a file open. It must cost it once.
    #[test]
    fn a_rollout_head_is_read_once() {
        let path = write(
            "codex-cwd",
            &[r#"{"timestamp":"2026-07-28T09:00:00.000Z","type":"session_meta","payload":{"id":"s","cwd":"D:\\Dev\\Thing","model":"gpt-5-codex"}}"#],
        );
        let c = candidate(&path);
        assert_eq!(cached_cwd(&c).as_deref(), Some("d:/dev/thing"));
        // Nothing left to open: the file is gone and the answer still stands.
        fs::remove_file(&path).unwrap();
        assert_eq!(cached_cwd(&c).as_deref(), Some("d:/dev/thing"));
    }
}
