#[tauri::command]
pub fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        if which::which("pwsh").is_ok() {
            return "pwsh".to_string();
        }
        if which::which("powershell").is_ok() {
            return "powershell".to_string();
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}
