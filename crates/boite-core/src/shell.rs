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

/// Per-user bin directories that CLI installers add to the *shell profile*
/// rather than to the machine PATH. A GUI process never sources that profile,
/// so on macOS and Linux every tool installed this way looks absent even though
/// it runs fine in the user's terminal.
fn user_bin_dirs() -> Vec<std::path::PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);
    let Some(home) = home else {
        return Vec::new();
    };
    [".bun/bin", ".local/bin", ".cargo/bin", ".deno/bin", "go/bin", "bin"]
        .iter()
        .map(|suffix| home.join(suffix))
        .filter(|p| p.is_dir())
        .collect()
}

/// Whether `name` resolves to something runnable on this machine.
///
/// Takes an executable name or path, never a command line: splitting a line on
/// whitespace here would cut `C:\Program Files\...\pwsh.exe` in half. Callers
/// that hold a full line pass its first token themselves.
///
/// `which` already knows PATHEXT on Windows and the executable bit elsewhere,
/// so a hand-rolled PATH walk only gets to be wrong in new ways.
pub fn command_exists(name: &str) -> bool {
    if name.trim().is_empty() {
        return false;
    }
    if which::which(name).is_ok() {
        return true;
    }
    let extra = user_bin_dirs();
    if extra.is_empty() {
        return false;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    which::which_in(name, Some(std::env::join_paths(extra).unwrap_or_default()), cwd).is_ok()
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
    fn command_exists_agrees_with_the_shell_this_machine_reports() {
        assert!(command_exists(&default_shell_blocking()));
        assert!(!command_exists("definitely-not-a-real-binary-xyz"));
        assert!(!command_exists(""));
        assert!(!command_exists("   "));
    }

    #[test]
    fn command_exists_takes_a_name_not_a_command_line() {
        // A shell path holds spaces on Windows ("C:\Program Files\..."), so a
        // whitespace split here would look up "C:\Program" and answer no.
        let shell = default_shell_blocking();
        assert!(command_exists(&shell));
        assert!(!command_exists(&format!("{shell} --version")));
    }

    #[test]
    fn shells_without_a_login_mode_get_nothing() {
        assert!(login_args_for("pwsh").is_empty());
        assert!(login_args_for("cmd").is_empty());
    }
}
