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
    #[serde(alias = "workingDirectory", alias = "working_directory")]
    working_dir: Option<String>,
}

fn normalize(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// Claude encodes a project directory by replacing every non-alphanumeric
/// char with `-`. Reproducing that here lets us match a session folder by
/// name when the JSONL body lacks a `cwd` field.
fn encode_project_dir(p: &str) -> String {
    p.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .to_lowercase()
}

fn ms_since_epoch(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_session_meta(path: &Path) -> Option<(Option<String>, Option<String>)> {
    let content = fs::read_to_string(path).ok()?;
    let mut found_session: Option<String> = None;
    let mut found_cwd: Option<String> = None;
    for line in content.lines().take(80) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<ClaudeSessionLine>(trimmed) else {
            continue;
        };
        if found_session.is_none() {
            found_session = parsed.session_id;
        }
        if found_cwd.is_none() {
            found_cwd = parsed.cwd.or(parsed.working_dir);
        }
        if found_session.is_some() && found_cwd.is_some() {
            break;
        }
    }
    Some((found_session, found_cwd))
}

#[tauri::command]
pub fn find_claude_session(cwd: String, after_unix_ms: i64) -> Option<String> {
    let home = dirs::home_dir()?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.is_dir() {
        return None;
    }

    let target_cwd = normalize(&cwd);
    let target_encoded = encode_project_dir(&target_cwd);

    struct Candidate {
        path: std::path::PathBuf,
        modified_ms: i64,
        dir_name_lower: String,
    }
    let mut candidates: Vec<Candidate> = Vec::new();

    let project_entries = fs::read_dir(&projects_dir).ok()?;
    for project_entry in project_entries.flatten() {
        let Ok(file_type) = project_entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let dir_name_lower = project_entry
            .file_name()
            .to_string_lossy()
            .to_lowercase();
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
            candidates.push(Candidate {
                path,
                modified_ms,
                dir_name_lower: dir_name_lower.clone(),
            });
        }
    }

    candidates.sort_by_key(|c| std::cmp::Reverse(c.modified_ms));

    for cand in candidates {
        let dir_matches =
            cand.dir_name_lower == target_encoded || target_encoded.contains(&cand.dir_name_lower);

        let (session_id, session_cwd) =
            read_session_meta(&cand.path).unwrap_or((None, None));

        let cwd_matches = session_cwd
            .as_deref()
            .map(|c| normalize(c) == target_cwd)
            .unwrap_or(false);

        if !cwd_matches && !dir_matches {
            continue;
        }

        if let Some(id) = session_id {
            return Some(id);
        }
        if let Some(stem) = cand.path.file_stem().and_then(|s| s.to_str()) {
            return Some(stem.to_string());
        }
    }

    None
}
