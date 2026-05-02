use serde::Serialize;

#[derive(Serialize)]
pub struct ShellOption {
    pub id: String,
    pub label: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub icon_key: Option<String>,
}

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

#[tauri::command]
pub fn available_shells() -> Vec<ShellOption> {
    let mut shells: Vec<ShellOption> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(path) = which::which("pwsh") {
            shells.push(ShellOption {
                id: "pwsh".into(),
                label: "PowerShell 7".into(),
                cmd: path.to_string_lossy().into_owned(),
                args: vec![],
                icon_key: Some("terminal".into()),
            });
        }
        if let Ok(path) = which::which("powershell") {
            shells.push(ShellOption {
                id: "powershell".into(),
                label: "Windows PowerShell".into(),
                cmd: path.to_string_lossy().into_owned(),
                args: vec![],
                icon_key: Some("terminal".into()),
            });
        }
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        shells.push(ShellOption {
            id: "cmd".into(),
            label: "Command Prompt".into(),
            cmd: comspec,
            args: vec![],
            icon_key: Some("terminal".into()),
        });

        let git_bash =
            std::path::Path::new("C:\\Program Files\\Git\\bin\\bash.exe").to_path_buf();
        if git_bash.is_file() {
            shells.push(ShellOption {
                id: "git-bash".into(),
                label: "Git Bash".into(),
                cmd: git_bash.to_string_lossy().into_owned(),
                args: vec!["--login".into(), "-i".into()],
                icon_key: Some("terminal".into()),
            });
        }

        if let Ok(path) = which::which("nu") {
            shells.push(ShellOption {
                id: "nushell".into(),
                label: "Nushell".into(),
                cmd: path.to_string_lossy().into_owned(),
                args: vec![],
                icon_key: Some("terminal".into()),
            });
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let candidates: &[(&str, &str)] = &[
            ("zsh", "Zsh"),
            ("bash", "Bash"),
            ("fish", "Fish"),
            ("nu", "Nushell"),
            ("sh", "POSIX sh"),
        ];
        for (bin, label) in candidates {
            if let Ok(path) = which::which(bin) {
                shells.push(ShellOption {
                    id: (*bin).to_string(),
                    label: (*label).to_string(),
                    cmd: path.to_string_lossy().into_owned(),
                    args: vec![],
                    icon_key: Some("terminal".into()),
                });
            }
        }
    }

    shells
}
