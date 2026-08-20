use std::fs;
use std::path::PathBuf;

// `Rng` is what `RngCore` was called before rand 0.10: same `fill_bytes`, and
// the thread RNG behind it is still a CSPRNG, which is the only property this
// token needs.
use rand::Rng;

pub struct Config {
    pub bind: String,
    pub data_dir: PathBuf,
    /// `BOITE_TOKEN`, or the token file beside the database.
    ///
    /// **A bootstrap credential, not a session credential.** Since device
    /// pairing landed it opens exactly one route, `POST /api/pairings`, and
    /// pairs a device. It cannot open a socket, call an RPC or mint a ticket.
    /// It survives at all so that the operator of a running deployment is not
    /// locked out of their own server by the change that locked out every
    /// device.
    pub bootstrap_token: String,
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
    /// What this boite is reached by from outside (`BOITE_PUBLIC_URL`), for the
    /// text of a pairing link. Behind a reverse proxy the server cannot work
    /// this out: the `Host` header is whatever the caller sent.
    pub public_url: Option<String>,
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

        let bootstrap_token = resolve_token(&data_dir)?;

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
        let public_url = std::env::var("BOITE_PUBLIC_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());

        Ok(Config {
            bind,
            data_dir,
            bootstrap_token,
            scrollback_bytes,
            static_dir,
            max_threads,
            max_connections,
            workspace_dir,
            public_url,
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
    rand::rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    crate::secret_file::write(&token_path, &token)
        .map_err(|e| format!("cannot write token file {}: {e}", token_path.display()))?;
    Ok(token)
}
