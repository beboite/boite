use std::fs;
use std::path::PathBuf;

use rand::RngCore;

pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    pub token: String,
    pub scrollback_bytes: usize,
    /// Directory of the built SvelteKit SPA to serve. None disables static
    /// serving (the WS API still works).
    pub static_dir: Option<PathBuf>,
    /// Max concurrent live PTYs; thread.spawn past this is rejected (DoS guard).
    pub max_threads: usize,
    /// Max concurrent authenticated WebSocket connections.
    pub max_connections: usize,
    /// Base directory clients may browse to add new projects (the mounted
    /// repos dir in Docker). Added as an always-allowed filesystem root so the
    /// web folder picker works before any project exists.
    pub workspace_dir: Option<PathBuf>,
}

const DEFAULT_SCROLLBACK: usize = 1024 * 1024;
const DEFAULT_MAX_THREADS: usize = 200;
const DEFAULT_MAX_CONNECTIONS: usize = 64;

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        // Loopback by default: a fresh install must not expose host-RCE-over-a-
        // static-token on every interface. Container/LAN deploys set BOITE_BIND
        // explicitly (and front it with TLS or a tunnel).
        let bind = std::env::var("BOITE_BIND").unwrap_or_else(|_| "127.0.0.1:7337".to_string());
        let data_dir = std::env::var("BOITE_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./boite-data"));
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("cannot create data dir {}: {e}", data_dir.display()))?;

        let token = resolve_token(&data_dir)?;

        let scrollback_bytes = std::env::var("BOITE_SCROLLBACK_BYTES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_SCROLLBACK);

        let static_dir = std::env::var("BOITE_STATIC_DIR").ok().map(PathBuf::from);
        let max_threads = env_usize("BOITE_MAX_THREADS", DEFAULT_MAX_THREADS);
        let max_connections = env_usize("BOITE_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS);
        let workspace_dir = std::env::var("BOITE_WORKSPACE_DIR")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);

        Ok(Config {
            bind,
            data_dir,
            token,
            scrollback_bytes,
            static_dir,
            max_threads,
            max_connections,
            workspace_dir,
        })
    }
}

// Token precedence: BOITE_TOKEN env, else the persisted token file, else a
// freshly generated 32-byte hex token written to the data dir (0600 on unix).
fn resolve_token(data_dir: &std::path::Path) -> Result<String, String> {
    if let Ok(t) = std::env::var("BOITE_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let token_path = data_dir.join("token");
    if let Ok(existing) = fs::read_to_string(&token_path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    fs::write(&token_path, &token)
        .map_err(|e| format!("cannot write token file {}: {e}", token_path.display()))?;
    set_token_permissions(&token_path);
    Ok(token)
}

#[cfg(unix)]
fn set_token_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_token_permissions(_path: &std::path::Path) {}
