use std::path::{Path, PathBuf};
use tauri::Webview;

fn resolve_file(directory: &Path, path: &Path) -> Result<PathBuf, String> {
    if !directory.is_absolute() {
        return Err(format!("directory {}: expected an absolute directory", directory.display()));
    }
    let root = directory.canonicalize().map_err(|error| format!("directory {}: {error}", directory.display()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
        std::fs::remove_dir_all(root).unwrap();
    }
}
