use std::ffi::OsStr;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

use serde::Deserialize;

#[derive(Deserialize)]
struct ClaudeSessionLine {
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    cwd: Option<String>,
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn ms_since_epoch(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_first_session_meta(path: &Path) -> Option<(Option<String>, Option<String>)> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(20) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<ClaudeSessionLine>(trimmed) {
            if parsed.session_id.is_some() || parsed.cwd.is_some() {
                return Some((parsed.session_id, parsed.cwd));
            }
        }
    }
    None
}

#[tauri::command]
pub fn find_claude_session(cwd: String, after_unix_ms: i64) -> Option<String> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.is_dir() {
        return None;
    }

    let target_cwd = normalize(&cwd);
    let mut candidates: Vec<(std::path::PathBuf, i64)> = Vec::new();

    let project_entries = fs::read_dir(&projects_dir).ok()?;
    for project_entry in project_entries.flatten() {
        let Ok(file_type) = project_entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let session_entries = match fs::read_dir(project_entry.path()) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for session_entry in session_entries.flatten() {
            let path = session_entry.path();
            if path.extension() != Some(OsStr::new("jsonl")) {
                continue;
            }
            let Ok(meta) = session_entry.metadata() else {
                continue;
            };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let modified_ms = ms_since_epoch(modified);
            if modified_ms < after_unix_ms {
                continue;
            }
            candidates.push((path, modified_ms));
        }
    }

    candidates.sort_by_key(|(_, t)| std::cmp::Reverse(*t));

    for (path, _) in candidates {
        let Some((session_id, session_cwd)) = read_first_session_meta(&path) else {
            continue;
        };
        let Some(session_cwd) = session_cwd else {
            continue;
        };
        if normalize(&session_cwd) != target_cwd {
            continue;
        }
        if let Some(id) = session_id {
            return Some(id);
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            return Some(stem.to_string());
        }
    }

    None
}
