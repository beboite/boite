mod account;

use crate::usage;
use chrono::{TimeZone, Utc};
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const TAIL_BYTES: u64 = 192 * 1024;
const TAIL_LINES: usize = 400;
const CONTEXT_LIMIT: f64 = 200_000.0;
const CONTEXT_LIMIT_LARGE: f64 = 1_000_000.0;

pub fn run() -> i32 {
    if std::env::var("STATUSLINE").is_ok_and(|flag| off(&flag)) {
        return 0;
    }
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    let payload: Value = serde_json::from_str(&stdin).unwrap_or(Value::Null);
    let line = build(&payload);
    if !line.is_empty() {
        print!("{line}");
    }
    0
}

pub fn off(flag: &str) -> bool {
    matches!(
        flag.trim().to_lowercase().as_str(),
        "0" | "false" | "off" | "no"
    )
}

fn colour_on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        std::env::var_os("NO_COLOR").is_none()
            && std::env::var("TERM").map(|t| t != "dumb").unwrap_or(true)
    })
}

fn paint(text: &str, code: &str) -> String {
    if colour_on() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn dim(text: &str) -> String {
    paint(text, "2")
}
pub fn bold(text: &str) -> String {
    paint(text, "1")
}
pub fn red(text: &str) -> String {
    paint(text, "31")
}
pub fn green(text: &str) -> String {
    paint(text, "32")
}
pub fn yellow(text: &str) -> String {
    paint(text, "33")
}
pub fn blue(text: &str) -> String {
    paint(text, "34")
}
pub fn magenta(text: &str) -> String {
    paint(text, "35")
}
pub fn cyan(text: &str) -> String {
    paint(text, "36")
}
pub fn orange(text: &str) -> String {
    paint(text, "38;5;208")
}
pub fn violet(text: &str) -> String {
    paint(text, "38;5;141")
}

struct Line<'a> {
    payload: &'a Value,
    cwd: PathBuf,
    tail: OnceLock<Vec<String>>,
}

fn build(payload: &Value) -> String {
    let line = Line {
        payload,
        cwd: workspace_dir(payload),
        tail: OnceLock::new(),
    };
    let g = account::glyphs();

    let limits = payload.get("rate_limits").cloned().unwrap_or(Value::Null);
    let groups: Vec<Vec<Option<String>>> = vec![
        vec![
            Some(bold(&line.model())),
            line.thinking(),
            line.permission(),
            line.style(),
        ],
        vec![Some(line.dir()), line.git()],
        vec![line.context()],
        vec![
            quota(limits.get("five_hour"), "5h"),
            quota(limits.get("seven_day"), "7j"),
        ],
        account::segments(payload)
            .into_iter()
            .chain(account::update_note())
            .map(Some)
            .collect(),
        vec![line.cost(), line.lines(), line.duration()],
    ];

    groups
        .into_iter()
        .map(|group| {
            group
                .into_iter()
                .flatten()
                .filter(|part| !part.is_empty())
                .collect::<Vec<String>>()
                .join(&dim(g.sep))
        })
        .filter(|group| !group.is_empty())
        .collect::<Vec<String>>()
        .join(&dim(g.group))
}

fn workspace_dir(payload: &Value) -> PathBuf {
    let named = payload
        .get("workspace")
        .and_then(|w| crate::jsonio::str_of(w, "current_dir"))
        .or_else(|| crate::jsonio::str_of(payload, "cwd"));
    match named {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

fn number(value: &Value, path: &[&str]) -> Option<f64> {
    let mut at = value;
    for key in path {
        at = at.get(*key)?;
    }
    at.as_f64()
}

fn bar(pct: f64, width: usize) -> String {
    let filled = ((pct / 100.0 * width as f64).round() as i64).clamp(0, width as i64) as usize;
    format!("{}{}", "▰".repeat(filled), dim(&"▱".repeat(width - filled)))
}

fn heat(pct: f64) -> fn(&str) -> String {
    if pct >= 85.0 {
        red
    } else if pct >= 65.0 {
        yellow
    } else {
        green
    }
}

fn short(tokens: f64) -> String {
    if tokens < 1000.0 {
        return format!("{}", tokens as i64);
    }
    if tokens < 10000.0 {
        return format!("{:.1}k", tokens / 1000.0);
    }
    format!("{}k", (tokens / 1000.0).round() as i64)
}

fn reset_time(value: Option<&Value>) -> Option<chrono::DateTime<Utc>> {
    match value? {
        Value::Number(seconds) => Utc.timestamp_opt(seconds.as_f64()? as i64, 0).single(),
        Value::String(text) => usage::parse_time(text),
        _ => None,
    }
}

fn until_reset(value: Option<&Value>) -> Option<String> {
    let at = reset_time(value)?;
    let minutes = ((at - Utc::now()).num_seconds() as f64 / 60.0).round() as i64;
    if minutes <= 0 {
        return None;
    }
    if minutes < 60 {
        return Some(format!("{minutes}m"));
    }
    let hours = (minutes as f64 / 60.0).round() as i64;
    if hours < 24 {
        return Some(format!("{hours}h"));
    }
    Some(format!("{}j", (hours as f64 / 24.0).round() as i64))
}

fn quota(limit: Option<&Value>, label: &str) -> Option<String> {
    let limit = limit?;
    let pct = limit
        .get("used_percentage")
        .and_then(Value::as_f64)?
        .min(100.0);
    let rounded = pct.round();
    let paint = heat(rounded);
    let mut out = format!(
        "{} {} {}",
        dim(label),
        paint(&bar(rounded, 5)),
        paint(&format!("{:>2}%", rounded as i64))
    );
    if rounded >= 50.0 {
        if let Some(left) = until_reset(limit.get("resets_at")) {
            out.push_str(&dim(&format!(" ↻{left}")));
        }
    }
    Some(out)
}

impl Line<'_> {
    fn model(&self) -> String {
        self.payload
            .get("model")
            .and_then(|m| {
                crate::jsonio::str_of(m, "display_name").or_else(|| crate::jsonio::str_of(m, "id"))
            })
            .unwrap_or_else(|| "?".into())
    }

    fn style(&self) -> Option<String> {
        let name = self
            .payload
            .get("output_style")
            .and_then(|s| crate::jsonio::str_of(s, "name"))?;
        if name == "default" || name == "null" {
            return None;
        }
        Some(yellow(&name))
    }

    fn thinking(&self) -> Option<String> {
        let fast = match self.payload.get("fast_mode").and_then(Value::as_bool) {
            Some(true) => format!("{} ", yellow("⚡")),
            _ => String::new(),
        };
        let enabled = self
            .payload
            .get("thinking")
            .and_then(|t| t.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if !enabled {
            return Some(format!("{fast}{}", dim("✻ off")));
        }
        let Some(level) = self
            .payload
            .get("effort")
            .and_then(|e| crate::jsonio::str_of(e, "level"))
        else {
            return Some(fast).filter(|f| !f.is_empty());
        };
        let paint = match level.as_str() {
            "low" => dim,
            "medium" => blue,
            "high" => green,
            _ => yellow,
        };
        Some(format!("{fast}{}", paint(&format!("✻ {level}"))))
    }

    fn permission(&self) -> Option<String> {
        let mode = crate::jsonio::str_of(self.payload, "permission_mode")
            .or_else(|| crate::jsonio::str_of(self.payload, "permissionMode"))
            .or_else(|| self.transcript_permission())?;
        if mode == "default" {
            return None;
        }
        if mode == "bypassPermissions" {
            return Some(red(&bold("⚠ bypass")));
        }
        let label = match mode.as_str() {
            "auto" => "auto",
            "acceptEdits" => "edits",
            "plan" => "plan",
            "dontAsk" => "no-ask",
            other => other,
        };
        Some(yellow(label))
    }

    fn transcript_permission(&self) -> Option<String> {
        for line in self.tail().iter().rev() {
            if !line.contains("\"permissionMode\"") {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if crate::jsonio::str_of(&entry, "type").as_deref() == Some("permission-mode") {
                if let Some(mode) = crate::jsonio::str_of(&entry, "permissionMode") {
                    return Some(mode);
                }
            }
        }
        None
    }

    fn context(&self) -> Option<String> {
        let window = self.payload.get("context_window");
        let (pct, used) = match window
            .and_then(|w| w.get("used_percentage"))
            .and_then(Value::as_f64)
        {
            Some(pct) => (
                pct.min(100.0).round(),
                number(window?, &["total_input_tokens"]).unwrap_or(0.0)
                    + number(window?, &["total_output_tokens"]).unwrap_or(0.0),
            ),
            None => {
                let used = self.transcript_tokens()?;
                let limit = match self
                    .payload
                    .get("exceeds_200k_tokens")
                    .and_then(Value::as_bool)
                {
                    Some(true) => CONTEXT_LIMIT_LARGE,
                    _ => CONTEXT_LIMIT,
                };
                ((used / limit * 100.0).round().min(100.0), used)
            }
        };
        let paint = heat(pct);
        Some(format!(
            "{} {}{}",
            paint(&bar(pct, 5)),
            paint(&format!("{}%", pct as i64)),
            dim(&format!(" {}", short(used)))
        ))
    }

    fn transcript_tokens(&self) -> Option<f64> {
        for line in self.tail().iter().rev() {
            let line = line.trim();
            if !line.starts_with('{') || !line.contains("\"usage\"") {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(usage) = entry.get("message").and_then(|m| m.get("usage")) else {
                continue;
            };
            let total: f64 = [
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
                "output_tokens",
            ]
            .iter()
            .filter_map(|name| usage.get(*name).and_then(Value::as_f64))
            .sum();
            if total > 0.0 {
                return Some(total);
            }
        }
        None
    }

    fn tail(&self) -> &Vec<String> {
        self.tail.get_or_init(|| {
            let Some(path) = crate::jsonio::str_of(self.payload, "transcript_path") else {
                return Vec::new();
            };
            read_tail(Path::new(&path)).unwrap_or_default()
        })
    }

    fn dir(&self) -> String {
        let project = self
            .payload
            .get("workspace")
            .and_then(|w| crate::jsonio::str_of(w, "project_dir"))
            .map(PathBuf::from);
        if let Some(project) = project.filter(|p| *p != self.cwd) {
            if let Ok(rest) = self.cwd.strip_prefix(&project) {
                let rest = rest.to_string_lossy().replace('\\', "/");
                if !rest.is_empty() {
                    return cyan(&format!("{}/{}", base_name(&project), rest));
                }
            }
        }
        cyan(&base_name(&self.cwd))
    }

    fn git(&self) -> Option<String> {
        let (git_dir, root) = git_dir(&self.cwd)?;
        let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
        let head = head.trim();
        let branch = match head.strip_prefix("ref: refs/heads/") {
            Some(name) => name.to_string(),
            None => head.chars().take(7).collect(),
        };
        let mark = match dirty(&root) {
            Some(true) => red("*"),
            _ => String::new(),
        };
        Some(format!("{}{mark}", magenta(&format!("⎇ {branch}"))))
    }

    fn cost(&self) -> Option<String> {
        let usd = number(self.payload, &["cost", "total_cost_usd"])?;
        let paint = if usd >= 10.0 {
            red
        } else if usd >= 3.0 {
            yellow
        } else {
            dim
        };
        let text = if usd >= 10.0 {
            format!("${usd:.1}")
        } else {
            format!("${usd:.2}")
        };
        Some(paint(&text))
    }

    fn lines(&self) -> Option<String> {
        let added = number(self.payload, &["cost", "total_lines_added"]).unwrap_or(0.0);
        let removed = number(self.payload, &["cost", "total_lines_removed"]).unwrap_or(0.0);
        if added == 0.0 && removed == 0.0 {
            return None;
        }
        Some(format!(
            "{}{}{}",
            green(&format!("+{}", added as i64)),
            dim("/"),
            red(&format!("-{}", removed as i64))
        ))
    }

    fn duration(&self) -> Option<String> {
        let ms = number(self.payload, &["cost", "total_duration_ms"])?;
        if ms < 60000.0 {
            return None;
        }
        let minutes = (ms / 60000.0).round() as i64;
        if minutes < 60 {
            return Some(dim(&format!("{minutes}m")));
        }
        Some(dim(&format!("{}h{:02}", minutes / 60, minutes % 60)))
    }
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn read_tail(path: &Path) -> Option<Vec<String>> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let start = size.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text
        .split('\n')
        .rev()
        .take(TAIL_LINES)
        .map(str::to_string)
        .collect();
    lines.reverse();
    Some(lines)
}

fn git_dir(from: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut at = from.canonicalize().unwrap_or_else(|_| from.to_path_buf());
    loop {
        let candidate = at.join(".git");
        if candidate.is_dir() {
            return Some((candidate, at));
        }
        if candidate.is_file() {
            if let Some(pointed) = std::fs::read_to_string(&candidate)
                .ok()
                .and_then(|text| pointer(&text))
            {
                let pointed = at.join(pointed);
                return Some((pointed.canonicalize().unwrap_or(pointed), at));
            }
        }
        at = at.parent()?.to_path_buf();
    }
}

fn pointer(text: &str) -> Option<PathBuf> {
    text.lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))
        .map(|rest| PathBuf::from(rest.trim()))
}

fn dirty(root: &Path) -> Option<bool> {
    let cache = dirty_cache_file(root);
    if let Some(fresh) = std::fs::metadata(&cache)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .filter(|age| age.as_secs() < 5)
        .and(std::fs::read_to_string(&cache).ok())
    {
        return match fresh.trim() {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        };
    }
    let out = std::process::Command::new("git")
        .args([
            "--no-optional-locks",
            "status",
            "--porcelain",
            "--untracked-files=no",
        ])
        .current_dir(root)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let dirty = !String::from_utf8_lossy(&out.stdout).trim().is_empty();
    let _ = std::fs::write(&cache, if dirty { "1" } else { "0" });
    Some(dirty)
}

fn dirty_cache_file(root: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let key = hasher
        .finalize()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    crate::provider::state_dir().join(format!("git-{key}.txt"))
}
