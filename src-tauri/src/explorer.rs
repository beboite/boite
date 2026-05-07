use std::path::Path;

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
