use super::Options;
use crate::jsonio;
use crate::live;
use crate::lock;
use crate::pool::{self, Pool, Trust};
use crate::provider::{Provider, ProviderId};
use crate::seal;
use crate::term::{say, Color};
use serde_json::Value;
use std::path::{Path, PathBuf};

const STALE_NAMES: [&str; 6] = [
    ".threads.state",
    ".watch.pid",
    ".watch.state",
    "watch.log",
    "watch-hidden.vbs",
    "relaunch.log",
];

struct Report {
    problems: u32,
}

impl Report {
    fn bad(&mut self, text: &str) {
        say(&format!("  ! {text}"), Color::Red);
        self.problems += 1;
    }
    fn warn(&self, text: &str) {
        say(&format!("  ~ {text}"), Color::Yellow);
    }
    fn good(&self, text: &str) {
        say(&format!("  . {text}"), Color::Dim);
    }
}

pub fn run(provider: &Provider, opts: &Options) -> i32 {
    let mut report = Report { problems: 0 };

    say(
        &format!("{} — {}", provider.label, provider.store.display()),
        Color::Cyan,
    );
    say(
        &format!(
            "  kebacc-switch {} on {} {}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
        Color::Dim,
    );

    if opts.rollback {
        let Some(backup) = live::newest_backup(provider) else {
            say("  No backup to roll back to.", Color::Yellow);
            return 1;
        };
        let put_back = lock::locked(lock::CRED_SWAP, || {
            live::set_creds_raw(provider, &backup.raw)
        });
        match put_back {
            Ok(Ok(())) => {}
            Ok(Err(problem)) => {
                say(&format!("  {problem}"), Color::Red);
                return 1;
            }
            Err(problem) => {
                say(&format!("  {problem}"), Color::Red);
                return 1;
            }
        }
        say(
            &format!(
                "  Put the credentials from {} back. The email in the config was left as it is.",
                backup.at.format("%Y-%m-%d %H:%M:%S")
            ),
            Color::Green,
        );
        return 0;
    }

    if let Some(shim) = install_dir()
        .map(|dir| dir.join("shim"))
        .filter(|s| s.exists())
    {
        report.warn(&format!(
            "An earlier version left {} on this machine. Remove it once nothing on your PATH points at it.",
            shim.display()
        ));
    }

    if let Some(dir) = install_dir() {
        if let Some((from, to, age)) = super::update::last(&dir) {
            report.good(&format!("updated from {from} to {to} {}", ago(age)));
        }
    }

    let backend = seal::backend();
    if backend == seal::Backend::None {
        report.warn("No OS secret store: snapshots cannot be encrypted on this machine.");
    } else {
        report.good(&format!("credentials sealed with {}", backend.name()));
    }

    if on_path(provider.cli) {
        report.good(&format!("{} found on PATH", provider.cli));
    } else {
        report.warn(&format!("{} is not on PATH.", provider.cli));
    }

    match live::creds_raw(provider) {
        Some(_) => {
            let email = live::identity(provider).and_then(|id| jsonio::str_of(&id, "emailAddress"));
            match email {
                Some(email) => report.good(&format!("logged in as {email}")),
                None => report.good(&format!("logged in ({})", provider.cred_label)),
            }
        }
        None => report.warn(&format!("not logged in ({})", provider.cred_label)),
    }

    if provider.id == ProviderId::Claude {
        check_settings(&mut report);
    }

    if !provider.store.exists() {
        report.warn("No pool directory yet. Nothing has been saved.");
        return exit_code(&report);
    }

    let store = Pool::new(provider);
    if store.key(false).is_none() {
        report.warn("The pool key is missing or unreadable: nothing can be verified.");
    }

    let mut plain = 0u32;
    for entry in store.entries() {
        let name = entry.file_name();
        say(&format!("  {}", entry.email), Color::Plain);

        if opts.protect && !entry.protected && entry.creds.is_some() {
            let saved = jsonio::str_of(&entry.snapshot, "savedAt");
            let (sealed, _) = pool::new_snapshot(
                &entry.email,
                entry.creds.as_deref().unwrap_or_default(),
                entry.identity.as_ref(),
                entry.cache.as_ref(),
                saved.as_deref(),
            );
            if jsonio::write(&entry.file, &sealed).is_ok() {
                store.register(&name, &sealed);
                report.good("sealed");
            } else {
                report.bad("could not be sealed");
            }
            continue;
        }
        if opts.adopt && entry.trust != Trust::Trusted {
            if store.register(&name, &entry.snapshot) {
                report.good("stamped");
            } else {
                report.warn("cannot be stamped: no stable account id");
            }
            continue;
        }

        if entry.creds.is_none() {
            report.bad("the credentials cannot be read back");
        } else if !entry.protected {
            report.warn("stored in plain text");
            plain += 1;
        }
        if entry.trust == Trust::Changed {
            report.bad("CHANGED since it was registered");
        } else if entry.trust != Trust::Trusted {
            report.warn(entry.trust.verdict().0);
        }
        if entry.creds.is_some() && entry.protected && entry.trust == Trust::Trusted {
            report.good("sealed and stamped");
        }
    }

    let stale = stale_files(provider);
    if !stale.is_empty() {
        if opts.clean {
            let mut removed = 0;
            for file in &stale {
                if std::fs::remove_file(file).is_ok() {
                    removed += 1;
                }
            }
            report.good(&format!(
                "removed {removed} leftover file(s) from an earlier version"
            ));
        } else {
            say(
                &format!(
                    "  {} leftover file(s) from an earlier version. Remove with: kebacc-switch doctor -Provider {} -Clean",
                    stale.len(),
                    provider.id.as_str()
                ),
                Color::Yellow,
            );
        }
    }

    if plain > 0 && !opts.protect {
        say(
            &format!(
                "  {plain} snapshot(s) in plain text. Fix with: kebacc-switch doctor -Provider {} -Protect",
                provider.id.as_str()
            ),
            Color::Yellow,
        );
    }
    exit_code(&report)
}

fn exit_code(report: &Report) -> i32 {
    if report.problems > 0 {
        1
    } else {
        0
    }
}

fn ago(age_ms: u128) -> String {
    let minutes = age_ms / 60_000;
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    format!("{}h ago", minutes / 60)
}

fn install_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

fn check_settings(report: &mut Report) {
    let path = crate::provider::claude_config_dir().join("settings.json");
    let settings = jsonio::read(&path).unwrap_or(Value::Null);

    let line = settings
        .get("statusLine")
        .and_then(|l| jsonio::str_of(l, "command"))
        .unwrap_or_default();
    if line.contains("statusline") && line.contains("kebacc-switch") {
        match missing_path(&line) {
            Some(gone) => report.bad(&format!(
                "the status line points at {gone}, which is not there"
            )),
            None => report.good("status line installed"),
        }
    } else {
        say(
            "  status line not installed. Add it with: install.ps1 -StatusLine",
            Color::Dim,
        );
    }

    let hooks = auto_hooks(&settings);
    match hooks.len() {
        0 => say(
            "  auto does not run on its own. Arm it with: install.ps1 -AutoSwitch all",
            Color::Dim,
        ),
        1 => report.good(&format!(
            "auto runs at every session start, for {}",
            hook_scope(&hooks[0]).unwrap_or_else(|| "claude".into())
        )),
        count => report.warn(&format!(
            "{count} session hooks run auto. Reinstall with -AutoSwitch to leave one."
        )),
    }
}

pub fn auto_hooks(settings: &Value) -> Vec<String> {
    let mut found = Vec::new();
    let Some(groups) = settings
        .get("hooks")
        .and_then(|h| h.get("SessionStart"))
        .and_then(Value::as_array)
    else {
        return found;
    };
    for group in groups {
        let Some(hooks) = group.get("hooks").and_then(Value::as_array) else {
            continue;
        };
        for hook in hooks {
            let Some(command) = hook.get("command").and_then(Value::as_str) else {
                continue;
            };
            if is_auto_command(command) {
                found.push(command.to_string());
            }
        }
    }
    found
}

pub fn is_auto_command(command: &str) -> bool {
    let lower = command.to_lowercase();
    let ours = ["kebacc-switch", "claude-c"]
        .iter()
        .any(|name| lower.contains(name));
    ours && lower.split_whitespace().any(|word| word == "auto")
}

pub fn hook_scope(command: &str) -> Option<String> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let at = words.iter().position(|w| {
        w.eq_ignore_ascii_case("-provider") || w.eq_ignore_ascii_case("--provider")
    })?;
    words
        .get(at + 1)
        .map(|w| {
            w.trim_matches(|c: char| !c.is_ascii_alphanumeric())
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
}

fn missing_path(command: &str) -> Option<String> {
    quoted_words(command)
        .into_iter()
        .filter(|word| word.contains('/') || word.contains('\\'))
        .find(|word| !Path::new(word).exists())
}

fn quoted_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some(open) if c == open => quote = None,
            Some(_) => word.push(c),
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == ' ' => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            None => word.push(c),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

fn stale_files(provider: &Provider) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = pool::snapshot_files(&provider.store)
        .into_iter()
        .filter(|p| {
            p.file_name()
                .map(|n| STALE_NAMES.contains(&n.to_string_lossy().as_ref()))
                .unwrap_or(false)
        })
        .collect();
    out.extend(
        pool::snapshot_files(&provider.backup_dir())
            .into_iter()
            .filter(|p| p.to_string_lossy().ends_with(".json.bak")),
    );
    out
}

fn on_path(cli: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&paths).any(|dir| {
        extensions
            .iter()
            .any(|ext| dir.join(format!("{cli}{ext}")).exists())
    })
}

#[cfg(test)]
mod tests {
    use super::quoted_words;

    #[test]
    fn a_quoted_path_with_a_space_stays_one_word() {
        let words = quoted_words("\"C:/Program Files/kebacc-switch.exe\" statusline");
        assert_eq!(words[0], "C:/Program Files/kebacc-switch.exe");
        assert_eq!(words[1], "statusline");
    }

    #[test]
    fn bare_words_split_on_spaces() {
        assert_eq!(quoted_words("a b  c"), vec!["a", "b", "c"]);
    }
}
