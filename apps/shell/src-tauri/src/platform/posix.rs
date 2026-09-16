use std::process::Command;
use tauri::AppHandle;

pub(crate) fn prepare_command(command: &mut Command) {
    // Finder and desktop launchers do not inherit interactive shell startup files.
    // Preserve the caller's order, then add common native CLI installation paths.
    let mut paths: Vec<_> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        for relative in [".local/bin", ".bun/bin", ".cargo/bin", ".npm-global/bin"] {
            let path = home.join(relative);
            if !paths.contains(&path) { paths.push(path); }
        }
    }
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        let path = std::path::PathBuf::from(directory);
        if !paths.contains(&path) { paths.push(path); }
    }
    if let Ok(path) = std::env::join_paths(paths) { command.env("PATH", path); }
}

pub(crate) fn notify(_app: AppHandle, _title: String, _body: String, _thread_id: String) -> Result<(), String> {
    Err("no system toast on this platform yet".to_string())
}
