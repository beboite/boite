//! Process environment bootstrap.
//!
//! An app launched from Finder or the Dock inherits launchd's environment, and
//! launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew, nvm, bun, cargo
//! and every agent CLI live outside it, so `which` misses them and the rc files
//! of the shells we spawn blow up the moment they call `brew`. Ask the login
//! shell for the PATH the user actually has, once, before anything spawns.

#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::time::{Duration, Instant};

/// Fenced so rc-file chatter on stdout can't be mistaken for the PATH.
#[cfg(unix)]
const BEGIN: &str = "__BOITE_PATH_BEGIN__";
#[cfg(unix)]
const END: &str = "__BOITE_PATH_END__";
/// An rc file that hangs must not hang the app; we keep the inherited PATH.
#[cfg(unix)]
const TIMEOUT: Duration = Duration::from_millis(3000);

/// Replace PATH with the login shell's, keeping any entry we already had.
///
/// Call before the first `which` lookup or PTY spawn. No-op on Windows, where
/// GUI processes already inherit the user PATH from the registry.
pub fn hydrate_login_path() {
    #[cfg(unix)]
    {
        if let Some(login_path) = login_shell_path() {
            let merged = merge_paths(&login_path, &std::env::var("PATH").unwrap_or_default());
            std::env::set_var("PATH", merged);
        }
    }
}

/// The shell to interrogate. launchd usually passes SHELL through, but a
/// process started without a user session may not have it.
#[cfg(unix)]
fn login_shell() -> String {
    match std::env::var("SHELL") {
        Ok(s) if !s.trim().is_empty() => s,
        _ => {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/sh".to_string()
            }
        }
    }
}

#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    // -l picks up the login files (/etc/zprofile, ~/.zprofile, ~/.bash_profile)
    // where Homebrew exports its prefix; -i picks up the rc files where nvm,
    // bun and pyenv usually land. Both matter, so ask for both.
    let script = format!("printf '{BEGIN}%s{END}' \"$PATH\"");
    let mut child = Command::new(login_shell())
        .arg("-lic")
        .arg(&script)
        .stdin(Stdio::null()) // an rc file that reads stdin gets EOF, not a hang
        .stdout(Stdio::piped())
        .stderr(Stdio::null()) // "no job control in this shell" and friends
        .spawn()
        .ok()?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }

    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    extract_fenced(&out)
}

#[cfg(unix)]
fn extract_fenced(out: &str) -> Option<String> {
    let start = out.find(BEGIN)? + BEGIN.len();
    let end = out[start..].find(END)? + start;
    let path = out[start..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Login PATH wins on ordering; anything only the current process had (a dev
/// run from a terminal, a wrapper script) is appended rather than dropped.
#[cfg(unix)]
fn merge_paths(login: &str, current: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for entry in login.split(':').chain(current.split(':')) {
        if !entry.is_empty() && !out.contains(&entry) {
            out.push(entry);
        }
    }
    out.join(":")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_login_order_and_appends_extras() {
        let merged = merge_paths("/opt/homebrew/bin:/usr/bin", "/usr/bin:/my/dev/bin");
        assert_eq!(merged, "/opt/homebrew/bin:/usr/bin:/my/dev/bin");
    }

    #[test]
    fn merge_drops_empty_entries() {
        assert_eq!(merge_paths("/usr/bin::", ":/bin"), "/usr/bin:/bin");
    }

    #[test]
    fn fenced_path_survives_rc_chatter() {
        let out = format!("welcome!\n{BEGIN}/opt/homebrew/bin:/usr/bin{END}\n");
        assert_eq!(
            extract_fenced(&out).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn unfenced_output_is_rejected() {
        assert_eq!(extract_fenced("/usr/bin:/bin"), None);
    }
}
