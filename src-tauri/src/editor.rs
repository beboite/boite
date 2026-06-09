use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub size: u64,
    pub is_readonly: bool,
    // Non-UTF-8 input decoded lossily: replacement chars stand in for the
    // original bytes, so saving this content back would corrupt the file.
    pub lossy: bool,
}

#[tauri::command]
pub async fn read_text_file(
    scope: tauri::State<'_, crate::scope::ProjectRoots>,
    path: String,
) -> Result<TextFile, String> {
    scope.ensure_allowed(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_blocking(&path))
        .await
        .map_err(|e| format!("read_text_file task failed: {e}"))?
}

fn read_blocking(path: &str) -> Result<TextFile, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err("not a file".into());
    }
    let meta = fs::metadata(p).map_err(|e| format!("stat failed: {e}"))?;
    let size = meta.len();
    if size > MAX_TEXT_BYTES {
        return Err(format!(
            "file too large ({} bytes > {} max)",
            size, MAX_TEXT_BYTES
        ));
    }
    let bytes = fs::read(p).map_err(|e| format!("read failed: {e}"))?;
    if looks_binary(&bytes) {
        return Err("binary file".into());
    }
    let (content, lossy) = match String::from_utf8(bytes) {
        Ok(s) => (s, false),
        Err(e) => (String::from_utf8_lossy(&e.into_bytes()).into_owned(), true),
    };
    let is_readonly = meta.permissions().readonly();
    Ok(TextFile {
        content,
        size,
        is_readonly,
        lossy,
    })
}

fn looks_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    head.contains(&0u8)
}

#[tauri::command]
pub async fn write_text_file(
    scope: tauri::State<'_, crate::scope::ProjectRoots>,
    path: String,
    content: String,
) -> Result<u64, String> {
    scope.ensure_allowed_for_write(&path)?;
    tauri::async_runtime::spawn_blocking(move || write_blocking(&path, &content))
        .await
        .map_err(|e| format!("write_text_file task failed: {e}"))?
}

fn write_blocking(path: &str, content: &str) -> Result<u64, String> {
    let p = Path::new(path);
    let parent = p
        .parent()
        .ok_or_else(|| "invalid path: no parent".to_string())?;
    if !parent.is_dir() {
        return Err(format!("parent not a directory: {}", parent.display()));
    }
    let file_name = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "invalid path: no file name".to_string())?;

    let mut tmp_path: PathBuf = parent.to_path_buf();
    tmp_path.push(format!(".{}.boite.tmp", file_name));

    {
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("create temp failed: {e}"))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("write temp failed: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync failed: {e}"))?;
    }

    if let Err(e) = fs::rename(&tmp_path, p) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("rename failed: {e}"));
    }
    Ok(content.len() as u64)
}
