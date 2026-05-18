use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
}

#[tauri::command]
pub async fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || read_dir_blocking(path))
        .await
        .map_err(|e| format!("read_dir task failed: {e}"))?
}

fn read_dir_blocking(path: String) -> Result<Vec<DirEntry>, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("not a directory".into());
    }

    let iter = std::fs::read_dir(p).map_err(|e| format!("read_dir failed: {e}"))?;
    let mut entries: Vec<DirEntry> = Vec::new();
    for item in iter.flatten() {
        let Ok(file_type) = item.file_type() else { continue };
        let Some(name) = item.file_name().to_str().map(|s| s.to_string()) else { continue };
        let Some(path_str) = item.path().to_str().map(|s| s.to_string()) else { continue };
        let is_hidden = name.starts_with('.');
        entries.push(DirEntry {
            name,
            path: path_str,
            is_dir: file_type.is_dir(),
            is_hidden,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub is_dir: bool,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".svelte-kit",
    ".next",
    ".turbo",
    ".cache",
    ".vite",
    ".nuxt",
    ".parcel-cache",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
];

#[tauri::command]
pub async fn explorer_search(
    path: String,
    query: String,
    limit: u32,
) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_blocking(&path, &query, limit))
        .await
        .map_err(|e| format!("explorer_search task failed: {e}"))?
}

fn search_blocking(root: &str, query: &str, limit: u32) -> Result<Vec<SearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err("not a directory".into());
    }
    let needle = trimmed.to_lowercase();
    let cap = limit.clamp(1, 2000) as usize;
    let mut hits: Vec<SearchHit> = Vec::new();
    walk(&root_path, &needle, cap, &mut hits);
    hits.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.path.to_lowercase().cmp(&b.path.to_lowercase()),
    });
    Ok(hits)
}

fn walk(dir: &Path, needle: &str, cap: usize, hits: &mut Vec<SearchHit>) {
    if hits.len() >= cap {
        return;
    }
    let Ok(iter) = std::fs::read_dir(dir) else { return };
    for item in iter.flatten() {
        if hits.len() >= cap {
            return;
        }
        let Ok(file_type) = item.file_type() else { continue };
        let Some(name) = item.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        let is_dir = file_type.is_dir();
        if is_dir && SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let path = item.path();
        let Some(path_str) = path.to_str().map(|s| s.to_string()) else { continue };
        if name.to_lowercase().contains(needle) {
            hits.push(SearchHit {
                path: path_str.clone(),
                is_dir,
            });
        }
        if is_dir {
            walk(&path, needle, cap, hits);
        }
    }
}
