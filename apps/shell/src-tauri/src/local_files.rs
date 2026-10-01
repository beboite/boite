use std::path::{Path, PathBuf};
use tauri::Webview;

fn resolve_file(directory: &Path, path: &Path) -> Result<PathBuf, String> {
    if !directory.is_absolute() {
        return Err(format!("directory {}: expected an absolute directory", directory.display()));
    }
    let root = directory.canonicalize().map_err(|error| format!("directory {}: {error}", directory.display()))?;
    if !root.is_dir() {
        return Err(format!("directory {}: expected a directory", directory.display()));
    }
    let candidate = root.join(path);
    let file = candidate.canonicalize().map_err(|error| format!("path {}: {error}", path.display()))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err(format!("path {}: expected a file inside {}", path.display(), directory.display()));
    }
    Ok(file)
}

/// Only a click in the main UI uses this command; browsed pages cannot call it.
#[tauri::command]
pub async fn open_local_file(webview: Webview, directory: String, path: String) -> Result<(), String> {
    crate::browser::only_main(&webview)?;
    let file = resolve_file(Path::new(&directory), Path::new(&path))?;
    crate::platform::open_file(&file)
}

fn resolve_chat_path(directory: &Path, path: &str) -> Result<PathBuf, String> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err("directory: expected an existing absolute thread directory".into());
    }
    if path.is_empty() || path.chars().any(char::is_control) || path.starts_with("\\\\") || path.starts_with("//") {
        return Err("path: expected a local file or folder, not a network or device path".into());
    }
    let candidate = directory.join(path);
    let resolved = candidate.canonicalize().map_err(|error| format!("path {path}: {error}"))?;
    if !resolved.is_file() && !resolved.is_dir() {
        return Err(format!("path {path}: expected a file or folder"));
    }
    Ok(resolved)
}

/// The opt-in chat-link action, invoked by a click in the main UI, never by an agent RPC or browsed page.
#[tauri::command]
pub async fn open_chat_file(webview: Webview, directory: String, path: String) -> Result<(), String> {
    crate::browser::only_main(&webview)?;
    let file = resolve_chat_path(Path::new(&directory), &path)?;
    crate::platform::open_file(&file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_links_allow_explicit_files_and_folders_outside_the_project_but_not_network_paths() {
        let root = std::env::temp_dir().join(format!("boite-chat-links-{}", std::process::id()));
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(root.join("test shortcut.lnk"), b"inert shortcut fixture").unwrap();
        std::fs::write(project.join("notes.txt"), b"notes").unwrap();
        assert!(resolve_chat_path(&project, "notes.txt").is_ok());
        assert_eq!(resolve_chat_path(&project, &root.join("test shortcut.lnk").to_string_lossy()).unwrap(), root.join("test shortcut.lnk").canonicalize().unwrap());
        assert!(resolve_chat_path(&project, &root.to_string_lossy()).unwrap().is_dir());
        for path in ["", "//server/share/file.txt", "\\\\server\\share\\file.txt", "bad\0file", "missing.txt"] {
            assert!(resolve_chat_path(&project, path).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_existing_files_and_rejects_paths_outside_the_thread() {
        let root = std::env::temp_dir().join(format!("boite-local-files-{}", std::process::id()));
        let inside = root.join("project");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::write(inside.join("game.exe"), b"inert fixture").unwrap();
        std::fs::write(root.join("outside.exe"), b"inert fixture").unwrap();
        assert_eq!(resolve_file(&inside, Path::new("game.exe")).unwrap(), inside.join("game.exe").canonicalize().unwrap());
        assert!(resolve_file(&inside, &inside.join("game.exe")).is_ok());
        assert!(resolve_file(&inside, Path::new("../outside.exe")).is_err());
        assert!(resolve_file(&inside, &root.join("outside.exe")).is_err());
        assert!(resolve_file(&inside, Path::new("missing.exe")).is_err());
        assert!(resolve_file(&inside, Path::new(".")).is_err());
        assert!(resolve_file(Path::new("relative"), Path::new("game.exe")).is_err());
        let error = resolve_file(&inside.join("game.exe"), &inside.join("game.exe")).unwrap_err();
        assert!(error.starts_with("directory ") && error.contains("expected a directory"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
