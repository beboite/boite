use std::path::Path;

use base64::Engine;
use serde::Serialize;

#[derive(Serialize)]
pub struct ProjectInspection {
    pub name: String,
    pub icon: Option<String>,
}

#[tauri::command]
pub fn inspect_project(path: String) -> Result<ProjectInspection, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }

    let name = git_remote_name(p)
        .or_else(|| basename(p))
        .unwrap_or_else(|| "project".to_string());
    let icon = find_icon(p);
    Ok(ProjectInspection { name, icon })
}

fn basename(p: &Path) -> Option<String> {
    p.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
}

fn git_remote_name(p: &Path) -> Option<String> {
    let cfg = p.join(".git").join("config");
    let content = std::fs::read_to_string(cfg).ok()?;

    let mut origin_url: Option<String> = None;
    let mut any_url: Option<String> = None;
    let mut current_remote: Option<String> = None;

    for raw in content.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("[remote \"") {
            if let Some(end) = rest.find('"') {
                current_remote = Some(rest[..end].to_string());
            } else {
                current_remote = None;
            }
            continue;
        }
        if line.starts_with('[') {
            current_remote = None;
            continue;
        }
        if current_remote.is_some() {
            if let Some(eq) = line.find('=') {
                let (key, val) = line.split_at(eq);
                if key.trim() == "url" {
                    let url = val[1..].trim().to_string();
                    if current_remote.as_deref() == Some("origin") {
                        origin_url = Some(url.clone());
                    }
                    if any_url.is_none() {
                        any_url = Some(url);
                    }
                }
            }
        }
    }

    let url = origin_url.or(any_url)?;
    repo_name_from_url(&url)
}

fn repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let after_colon = trimmed.rsplit(':').next().unwrap_or(trimmed);
    let last = after_colon.rsplit('/').next().unwrap_or(after_colon);
    let name = last.trim_end_matches(".git");
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn find_icon(p: &Path) -> Option<String> {
    let candidates = [
        "logo.svg",
        "logo.png",
        "icon.svg",
        "icon.png",
        "favicon.svg",
        "favicon.png",
        "favicon.ico",
        "public/favicon.svg",
        "public/favicon.png",
        "public/favicon.ico",
        "public/logo.svg",
        "public/logo.png",
        "public/icon.svg",
        "public/icon.png",
        "static/favicon.svg",
        "static/favicon.png",
        "static/favicon.ico",
        "static/logo.svg",
        "static/logo.png",
        "static/icon.svg",
        "static/icon.png",
        "src-tauri/icons/128x128.png",
        "src-tauri/icons/icon.png",
        "app-icon.png",
        ".github/logo.png",
        "docs/logo.png",
        "assets/logo.png",
        "assets/icon.png",
    ];

    const MAX_SIZE: u64 = 2 * 1024 * 1024;

    for c in &candidates {
        let path = p.join(c);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_SIZE {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let mime = match path.extension().and_then(|s| s.to_str()) {
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("ico") => "image/x-icon",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            _ => continue,
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Some(format!("data:{};base64,{}", mime, b64));
    }
    None
}
