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
}

const DEFAULT_SCROLLBACK: usize = 1024 * 1024;

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let bind = std::env::var("BOITE_BIND").unwrap_or_else(|_| "0.0.0.0:7337".to_string());
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

        Ok(Config {
            bind,
            data_dir,
            token,
            scrollback_bytes,
            static_dir,
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
