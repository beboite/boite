use serde::Serialize;

#[derive(Serialize)]
pub struct ShellOption {
    pub id: String,
    pub label: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub icon_key: Option<String>,
}

/// Args that make `cmd` behave like the shell Terminal.app hands you.
///
/// A bare interactive shell skips the login files (`/etc/zprofile`,
/// `~/.zprofile`, `~/.bash_profile`) where Homebrew and friends export PATH, so
/// the first rc line that calls `brew` fails with "command not found". Returns
/// an empty vec for anything that is not a shell we know how to log into.
pub fn login_args_for(cmd: &str) -> Vec<String> {
    let name = std::path::Path::new(cmd)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match name.as_str() {
        "zsh" | "bash" | "sh" | "dash" | "ksh" | "fish" => vec!["-l".to_string()],
        // nushell spells it out and rejects the short form.
        "nu" => vec!["--login".to_string()],
        _ => vec![],
    }
}

pub fn fallback_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        "cmd.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "/bin/bash".to_string()
    }
}

pub fn default_shell_blocking() -> String {
    #[cfg(target_os = "windows")]
    {
        if let Ok(p) = which::which("pwsh") {
            return p.to_string_lossy().into_owned();
        }
        if let Ok(p) = which::which("powershell") {
            return p.to_string_lossy().into_owned();
        }
        if let Ok(comspec) = std::env::var("COMSPEC") {
            if let Ok(p) = which::which(&comspec) {
                return p.to_string_lossy().into_owned();
            }
            return comspec;
        }
        if let Ok(p) = which::which("cmd.exe") {
            return p.to_string_lossy().into_owned();
        }
        "cmd.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if let Ok(p) = which::which(&shell) {
                return p.to_string_lossy().into_owned();
            }
            return shell;
        }
        "/bin/bash".to_string()
    }
}

#[cfg(target_os = "windows")]
fn git_bash_path() -> Option<std::path::PathBuf> {
    let candidates = [
        std::env::var("PROGRAMFILES").ok(),
        std::env::var("ProgramW6432").ok(),
        std::env::var("ProgramFiles(x86)").ok(),
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|l| format!("{}\\Programs", l)),
    ];
    for base in candidates.into_iter().flatten() {
        let p = std::path::Path::new(&base).join("Git").join("bin").join("bash.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    which::which("bash").ok()
}

pub fn available_shells_blocking() -> Vec<ShellOption> {
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

        if let Some(git_bash) = git_bash_path() {
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
                    args: login_args_for(bin),
                    icon_key: Some("terminal".into()),
                });
            }
        }
    }

    shells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_shells_get_login_flag() {
        assert_eq!(login_args_for("/bin/zsh"), vec!["-l".to_string()]);
        assert_eq!(login_args_for("bash"), vec!["-l".to_string()]);
        assert_eq!(login_args_for("/opt/homebrew/bin/fish"), vec!["-l".to_string()]);
        assert_eq!(login_args_for("nu"), vec!["--login".to_string()]);
    }

    #[test]
    fn agent_clis_are_left_alone() {
        assert!(login_args_for("claude").is_empty());
        assert!(login_args_for("/usr/local/bin/codex").is_empty());
    }

    #[test]
    fn shells_without_a_login_mode_get_nothing() {
        assert!(login_args_for("pwsh").is_empty());
        assert!(login_args_for("cmd").is_empty());
    }
}
