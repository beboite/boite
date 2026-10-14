//! Files and folders dragged from the system onto the main window. The web
//! view gets paths, not `File`s, from the native drop, so the UI asks here what
//! each path is and, for a file it attaches to a message, its bytes.
//!
//! Only the paths of the drag in progress or the last drop can be read: the UI
//! cannot use these commands to read any other file on the computer.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{State, Webview};

/// `ATTACHMENT_MAX_BYTES` in `packages/contracts/src/attachment-limits.ts`.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// The paths of the drag that entered the window last, or of its drop.
#[derive(Default)]
pub struct Dropped(Mutex<Vec<PathBuf>>);

impl Dropped {
    /// Called from the window's event handler, before the page hears of it.
    pub(crate) fn remember(&self, paths: &[PathBuf]) {
        if let Ok(mut held) = self.0.lock() {
            *held = paths.to_vec();
        }
    }

    fn holds(&self, path: &Path) -> bool {
        self.0.lock().map(|held| held.iter().any(|known| known == path)).unwrap_or(false)
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DroppedEntry {
    pub path: String,
    pub name: String,
    pub directory: bool,
    /// Bytes for a file, 0 for a folder.
    pub size: u64,
}

fn entry(path: &Path) -> Result<DroppedEntry, String> {
    let meta = std::fs::metadata(path).map_err(|error| format!("path {}: {error}", path.display()))?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    Ok(DroppedEntry {
        path: path.display().to_string(),
        name,
        directory: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
    })
}

fn known(dropped: &Dropped, path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !dropped.holds(&path) {
        return Err(format!("path {}: expected a path of the last drop on the window", path.display()));
    }
    Ok(path)
}

/// What each dropped path is. A path that vanished since the drop is left out.
#[tauri::command]
pub async fn dropped_entries(webview: Webview, dropped: State<'_, Dropped>, paths: Vec<String>) -> Result<Vec<DroppedEntry>, String> {
    crate::browser::only_main(&webview)?;
    let mut entries = Vec::with_capacity(paths.len());
    for path in paths {
        let path = known(&dropped, &path)?;
        if let Ok(found) = entry(&path) {
            entries.push(found);
        }
    }
    Ok(entries)
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    let found = entry(path)?;
    if found.directory {
        return Err(format!("path {}: expected a file, got a folder", path.display()));
    }
    if found.size > MAX_BYTES {
        return Err(format!("path {}: expected at most {MAX_BYTES} bytes, got {}", path.display(), found.size));
    }
    std::fs::read(path).map_err(|error| format!("path {}: {error}", path.display()))
}

/// The bytes of one dropped file, up to the attachment cap. Async, so the read
/// stays off the main thread.
#[tauri::command]
pub async fn dropped_file(webview: Webview, dropped: State<'_, Dropped>, path: String) -> Result<Response, String> {
    crate::browser::only_main(&webview)?;
    let path = known(&dropped, &path)?;
    read(&path).map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_paths_of_the_last_drag_are_known() {
        let dropped = Dropped::default();
        let dir = std::env::temp_dir();
        dropped.remember(&[dir.join("a.png")]);
        assert!(known(&dropped, &dir.join("a.png").display().to_string()).is_ok());
        assert!(known(&dropped, &dir.join("b.png").display().to_string()).is_err());
        dropped.remember(&[dir.join("b.png")]);
        assert!(known(&dropped, &dir.join("a.png").display().to_string()).is_err());
    }

    #[test]
    fn files_are_read_and_folders_and_oversized_files_refused() {
        let root = std::env::temp_dir().join(format!("boite-dropped-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let small = root.join("small.txt");
        std::fs::write(&small, b"hello").unwrap();
        let big = root.join("big.bin");
        std::fs::File::create(&big).unwrap().set_len(MAX_BYTES + 1).unwrap();

        assert_eq!(read(&small).unwrap(), b"hello");
        assert!(read(&root).unwrap_err().contains("got a folder"));
        assert!(read(&big).unwrap_err().contains("at most"));
        let folder = entry(&root).unwrap();
        assert!(folder.directory);
        assert_eq!(entry(&small).unwrap(), DroppedEntry { path: small.display().to_string(), name: "small.txt".into(), directory: false, size: 5 });
        std::fs::remove_dir_all(&root).unwrap();
    }
}
