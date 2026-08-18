use std::path::{Path, PathBuf};

pub const PROVIDER_IDS: [&str; 2] = ["claude", "codex"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProviderId {
    Claude,
    Codex,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Codex => "codex",
        }
    }
}

pub struct Provider {
    pub id: ProviderId,
    pub label: &'static str,
    pub cli: &'static str,
    pub store: PathBuf,
    pub cred_candidates: Vec<PathBuf>,
    pub config_candidates: Vec<PathBuf>,
    pub cred_label: &'static str,
    pub uses_keychain: bool,
    pub keychain_service: Option<&'static str>,
}

pub fn home() -> PathBuf {
    match dirs::home_dir() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => {
            eprintln!(
                "! No home directory: refusing to read or write credentials relative to the current directory."
            );
            std::process::exit(1);
        }
    }
}

pub fn state_dir() -> PathBuf {
    let dir = match std::env::var_os("KEBACC_SWITCH_STATE_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => home().join(".kebacc-switch"),
    };
    if std::fs::create_dir_all(&dir).is_ok() {
        protect_dir(&dir);
    }
    dir
}

pub fn claude_config_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home().join(".claude"),
    }
}

pub fn is_all(id: &str) -> bool {
    matches!(
        id.trim().to_ascii_lowercase().as_str(),
        "all" | "every" | "*"
    )
}

pub fn resolve(id: &str) -> Result<ProviderId, String> {
    let key = id.trim().to_ascii_lowercase();
    if key.is_empty() {
        return Ok(ProviderId::Claude);
    }
    match key.as_str() {
        "claude" | "claude-code" | "claudecode" | "cc" | "anthropic" => Ok(ProviderId::Claude),
        "codex" | "openai" | "chatgpt" | "gpt" => Ok(ProviderId::Codex),
        _ => Err(format!(
            "Unknown provider '{id}'. Known providers: {}.",
            PROVIDER_IDS.join(", ")
        )),
    }
}

pub fn newest(paths: &[PathBuf]) -> Option<PathBuf> {
    paths
        .iter()
        .filter(|p| p.exists())
        .max_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        })
        .cloned()
}

pub fn spec(id: ProviderId) -> Provider {
    match id {
        ProviderId::Codex => {
            let dir = match std::env::var_os("CODEX_HOME") {
                Some(d) if !d.is_empty() => PathBuf::from(d),
                _ => home().join(".codex"),
            };
            Provider {
                id,
                label: "Codex",
                cli: "codex",
                store: store_dir(
                    "KEBACC_SWITCH_CODEX_ACCOUNTS",
                    ".kebacc-switch-codex-accounts",
                ),
                cred_candidates: vec![dir.join("auth.json")],
                config_candidates: vec![dir.join("auth.json")],
                cred_label: "~/.codex/auth.json",
                uses_keychain: false,
                keychain_service: None,
            }
        }
        ProviderId::Claude => {
            let dir = claude_config_dir();
            Provider {
                id,
                label: "Claude Code",
                cli: "claude",
                store: store_dir("KEBACC_SWITCH_ACCOUNTS", ".kebacc-switch-accounts"),
                cred_candidates: vec![dir.join(".credentials.json")],
                config_candidates: vec![home().join(".claude.json"), dir.join(".claude.json")],
                cred_label: "~/.claude/.credentials.json",
                uses_keychain: cfg!(target_os = "macos"),
                keychain_service: Some("Claude Code-credentials"),
            }
        }
    }
}

fn store_dir(env: &str, default: &str) -> PathBuf {
    match std::env::var_os(env) {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => home().join(default),
    }
}

impl Provider {
    pub fn cred_file(&self) -> PathBuf {
        newest(&self.cred_candidates).unwrap_or_else(|| self.cred_candidates[0].clone())
    }

    pub fn config_file(&self) -> PathBuf {
        newest(&self.config_candidates).unwrap_or_else(|| self.config_candidates[0].clone())
    }

    pub fn is_codex(&self) -> bool {
        self.id == ProviderId::Codex
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.store.join(".backups")
    }

    pub fn snapshot_path(&self, email: &str) -> PathBuf {
        let safe: String = email
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.store.join(format!("{safe}.json"))
    }
}

pub fn protect_file(path: &Path) {
    if !path.exists() {
        return;
    }
    restrict(path, false);
}

pub fn protect_dir(path: &Path) {
    protect_dir_once(path);
}

#[cfg(windows)]
pub fn protect_new_file(path: &Path) {
    let owned = path.parent().is_some_and(is_locked_down);
    if !owned {
        protect_file(path);
    }
}

#[cfg(not(windows))]
pub fn protect_new_file(path: &Path) {
    protect_file(path);
}

fn locked_down() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    static DONE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    DONE.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

#[cfg(windows)]
fn is_locked_down(dir: &Path) -> bool {
    locked_down()
        .lock()
        .map(|done| done.contains(dir))
        .unwrap_or(false)
}

pub fn protect_dir_once(dir: &Path) {
    if !dir.is_dir() {
        return;
    }
    let Ok(mut done) = locked_down().lock() else {
        return;
    };
    if done.insert(dir.to_path_buf()) {
        restrict(dir, true);
    }
}

#[cfg(windows)]
fn restrict(path: &Path, dir: bool) {
    let grant = if dir {
        "*S-1-3-4:(OI)(CI)F"
    } else {
        "*S-1-3-4:(F)"
    };
    let _ = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r", grant])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn restrict(path: &Path, dir: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if dir { 0o700 } else { 0o600 };
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}
