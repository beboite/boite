use serde::Serialize;

#[derive(Serialize)]
pub struct ShellOption {
    pub id: String,
    pub label: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub icon_key: Option<String>,
}

/// The lowercased binary name behind a shell path, extension dropped.
///
/// `Path::file_stem` only splits on `\` when the crate is compiled for Windows,
/// so a Windows path handed to a Linux build comes back whole and every family
/// match below falls through to `Unknown`. Both separators are cut here so the
/// answer depends on the string, not on the host that asks.
fn binary_stem(cmd: &str) -> String {
    let last = cmd.rsplit(['/', '\\']).next().unwrap_or(cmd);
    std::path::Path::new(last)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Args that make `cmd` behave like the shell Terminal.app hands you.
///
/// A bare interactive shell skips the login files (`/etc/zprofile`,
/// `~/.zprofile`, `~/.bash_profile`) where Homebrew and friends export PATH, so
/// the first rc line that calls `brew` fails with "command not found". Returns
/// an empty vec for anything that is not a shell we know how to log into.
pub fn login_args_for(cmd: &str) -> Vec<String> {
    match binary_stem(cmd).as_str() {
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

/// The shell family a binary path belongs to, which is all the wrapping logic
/// below needs to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFamily {
    PowerShell,
    Cmd,
    /// Every shell that takes `-i -c` and knows `$0`. They share a wrapping
    /// form but not a way to list their own names, hence the split below.
    Bash,
    Zsh,
    /// `sh`, `dash`, `ksh`: POSIX, so aliases but no portable function listing.
    Posix,
    Fish,
    Nushell,
    Unknown,
}

pub fn family_of(cmd: &str) -> ShellFamily {
    match binary_stem(cmd).as_str() {
        "pwsh" | "powershell" => ShellFamily::PowerShell,
        "cmd" => ShellFamily::Cmd,
        "bash" => ShellFamily::Bash,
        "zsh" => ShellFamily::Zsh,
        "sh" | "dash" | "ksh" => ShellFamily::Posix,
        "fish" => ShellFamily::Fish,
        "nu" => ShellFamily::Nushell,
        _ => ShellFamily::Unknown,
    }
}

fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"', '\'']) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

/// Rebuilds the command line the user would have typed at the prompt.
pub fn build_command_line(cmd: &str, args: &[String]) -> String {
    std::iter::once(cmd)
        .chain(args.iter().map(String::as_str))
        .map(quote_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Argv that runs `cmd args` *inside* `shell`, so the shell's own profile has
/// been sourced and its functions and aliases resolve.
///
/// Passed as an argument, never typed into the PTY: injecting into stdin means
/// guessing when the prompt is ready, and a wrong guess feeds the first
/// characters of the command to a shell that is still starting up.
///
/// The shell is kept alive afterwards (`-NoExit`, `/k`, `exec $SHELL`) because
/// that is what the user gets when they run the command themselves: the process
/// ends, the prompt comes back, the terminal stays usable.
pub fn wrap_argv(
    shell_cmd: &str,
    shell_args: &[String],
    no_profile: bool,
    cmd: &str,
    args: &[String],
) -> Option<Vec<String>> {
    let line = build_command_line(cmd, args);
    let mut out: Vec<String> = shell_args.to_vec();
    match family_of(shell_cmd) {
        ShellFamily::PowerShell => {
            out.push("-NoLogo".into());
            if no_profile {
                // Contradictory on its face, but the caller owns that choice:
                // it only ever reaches here for a command the profile does not
                // define, and skipping the profile is the faster start.
                out.push("-NoProfile".into());
            }
            out.push("-NoExit".into());
            out.push("-Command".into());
            out.push(line);
        }
        ShellFamily::Cmd => {
            out.push("/k".into());
            out.push(line);
        }
        ShellFamily::Bash | ShellFamily::Zsh | ShellFamily::Posix => {
            // -i sources the interactive rc file, which is where functions and
            // aliases live; exec keeps the shell after the command returns.
            out.push("-i".into());
            out.push("-c".into());
            out.push(format!("{line}; exec \"$0\" -i"));
            // Sets $0 for the -c script, so the re-exec uses this very shell
            // rather than whatever the name resolves to on PATH.
            out.push(shell_cmd.to_string());
        }
        ShellFamily::Fish => {
            // fish has no $0, so the re-exec form above dies with "The expanded
            // command was empty" and takes the session with it. -C runs the
            // line after config.fish and then hands over to the interactive
            // session fish was going to start anyway, which is the same
            // contract without the re-exec.
            out.push("-i".into());
            out.push("-C".into());
            out.push(line);
        }
        // nu resolves its own defs with -c but has no "stay open" flag, and an
        // unknown shell has no contract at all. Better to spawn direct than to
        // invent flags that turn into a spawn failure.
        ShellFamily::Nushell | ShellFamily::Unknown => return None,
    }
    Some(out)
}

/// The command that lists every name the shell resolves *before* the PATH:
/// functions and aliases. Used to decide whether a shortcut needs the shell at
/// all, and to catch the case where a function shadows a binary of the same
/// name.
/// Separates the two halves of the probe's output.
pub const PROBE_SEPARATOR: &str = "--boite-probe--";

pub fn names_probe_argv(shell_cmd: &str) -> Option<Vec<String>> {
    let family = family_of(shell_cmd);
    if family == ShellFamily::PowerShell {
        return Some(vec![
            "-NoLogo".into(),
            "-Command".into(),
            format!(
                "Get-Command -CommandType Function,Alias -ErrorAction SilentlyContinue | \
                 ForEach-Object Name; '{PROBE_SEPARATOR}'; \
                 Get-ChildItem Env: | ForEach-Object {{ \"$($_.Name)=$($_.Value)\" }}"
            ),
        ]);
    }

    // One line per shell, because there is no portable way to ask. `compgen` is
    // a bash builtin: zsh and fish answer "command not found" and the probe
    // quietly degrades to its env half, which loses exactly the shadowing case
    // it exists to catch.
    let list = match family {
        ShellFamily::Bash => "compgen -A function -A alias",
        ShellFamily::Zsh => "print -l ${(k)functions} ${(k)aliases}",
        // fish implements alias as a function, so one listing covers both.
        ShellFamily::Fish => "functions -n",
        // POSIX has no portable function listing; aliases are what is left.
        ShellFamily::Posix => "alias | sed -e 's/^alias //' -e 's/=.*$//'",
        // cmd has doskey macros, which are per-console and cannot be listed
        // from a child process; nushell and unknown shells are not wrapped.
        _ => return None,
    };
    Some(vec![
        "-i".into(),
        "-c".into(),
        format!("{list}; echo '{PROBE_SEPARATOR}'; env"),
    ])
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

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn command_line_quotes_only_what_needs_it() {
        assert_eq!(build_command_line("cc", &v(&["--resume"])), "cc --resume");
        assert_eq!(
            build_command_line("ccCROF", &v(&["--md", "deepseek.md"])),
            "ccCROF --md deepseek.md"
        );
        assert_eq!(
            build_command_line("claude", &v(&["-p", "hello world"])),
            "claude -p \"hello world\""
        );
        assert_eq!(
            build_command_line("c:\\a b\\claude.exe", &v(&[])),
            "\"c:\\a b\\claude.exe\""
        );
        assert_eq!(build_command_line("say", &v(&["a\"b"])), "say \"a\\\"b\"");
    }

    #[test]
    fn powershell_wrap_passes_the_command_as_an_argument() {
        let argv = wrap_argv("C:\\pwsh.exe", &[], false, "cc", &v(&["--resume"])).unwrap();
        assert_eq!(argv, v(&["-NoLogo", "-NoExit", "-Command", "cc --resume"]));
    }

    #[test]
    fn powershell_wrap_honours_no_profile() {
        let argv = wrap_argv("pwsh", &[], true, "cc", &[]).unwrap();
        assert!(argv.contains(&"-NoProfile".to_string()));
    }

    #[test]
    fn cmd_and_posix_have_their_own_stay_open_form() {
        assert_eq!(
            wrap_argv("C:\\Windows\\system32\\cmd.exe", &[], false, "cc", &[]).unwrap(),
            v(&["/k", "cc"])
        );
        assert_eq!(
            wrap_argv("/bin/bash", &[], false, "cc", &v(&["-p", "x"])).unwrap(),
            v(&["-i", "-c", "cc -p x; exec \"$0\" -i", "/bin/bash"])
        );
    }

    #[test]
    fn wrap_keeps_the_shells_own_args_in_front() {
        let argv = wrap_argv("bash.exe", &v(&["--login"]), false, "cc", &[]).unwrap();
        assert_eq!(argv[0], "--login");
    }

    #[test]
    fn a_path_names_the_same_shell_on_every_host() {
        assert_eq!(
            family_of("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
            ShellFamily::PowerShell
        );
        assert_eq!(family_of("/usr/bin/zsh"), ShellFamily::Zsh);
        assert_eq!(login_args_for("C:\\Git\\bin\\bash.exe"), v(&["-l"]));
    }

    #[test]
    fn shells_we_cannot_wrap_return_none() {
        assert!(wrap_argv("nu", &[], false, "cc", &[]).is_none());
        assert!(wrap_argv("/usr/bin/claude", &[], false, "cc", &[]).is_none());
    }

    #[test]
    fn only_shells_with_a_listable_namespace_get_probed() {
        assert!(names_probe_argv("pwsh").is_some());
        assert!(names_probe_argv("/bin/zsh").is_some());
        assert!(names_probe_argv("cmd.exe").is_none());
        assert!(names_probe_argv("nu").is_none());
    }

    #[test]
    fn each_shell_lists_names_the_way_it_can() {
        // compgen is a bash builtin. Handing it to zsh or fish costs the whole
        // names half of the probe, silently.
        let probe = |cmd: &str| names_probe_argv(cmd).unwrap().join(" ");
        assert!(probe("/bin/bash").contains("compgen -A function -A alias"));
        assert!(probe("/bin/zsh").contains("${(k)functions}"));
        assert!(!probe("/bin/zsh").contains("compgen"));
        assert!(probe("/usr/bin/fish").contains("functions -n"));
        assert!(!probe("/usr/bin/fish").contains("compgen"));
        assert!(probe("/bin/dash").contains("alias |"));
        // Every one of them still has to emit both halves.
        for shell in ["/bin/bash", "/bin/zsh", "/usr/bin/fish", "/bin/dash"] {
            assert!(probe(shell).contains(PROBE_SEPARATOR), "{shell}");
            assert!(probe(shell).ends_with("env"), "{shell}");
        }
    }

    #[test]
    fn fish_stays_open_without_the_re_exec_form() {
        // "$0" is not a variable in fish: the re-exec expands to nothing and
        // fish exits with "The expanded command was empty".
        let argv = wrap_argv("/usr/bin/fish", &[], false, "cc", &v(&["--resume"])).unwrap();
        assert_eq!(argv, v(&["-i", "-C", "cc --resume"]));
        assert!(!argv.iter().any(|a| a.contains("$0")));
    }
}
