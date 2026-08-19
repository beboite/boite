//! Where this machine's home directory is, for the one module that must not
//! guess.
//!
//! `BOITE_CLI_HOME` is read here under the name the CLI manager uses for the
//! same purpose. Deliberately the same name: an integration run that redirects
//! one redirects both, and the day the two modules meet in one branch this file
//! is deleted rather than reconciled.
//!
//! Nothing below this is used by the tests. Every function in `sync` that needs
//! a home takes it as an argument, and only the module's public entry points
//! call in here — the same discipline the purge tests keep, and strictly better
//! than setting an environment variable, which is process-global while cargo
//! runs tests in threads.

use std::path::PathBuf;

/// The environment variable that moves the home a sync reads and writes.
pub const HOME_OVERRIDE: &str = "BOITE_CLI_HOME";

/// This machine's home directory.
pub fn home_dir() -> Option<PathBuf> {
    if let Some(overridden) = override_dir() {
        return Some(overridden);
    }
    dirs::home_dir()
}

/// Whether the home in use is one somebody pointed us at.
pub fn home_overridden() -> bool {
    override_dir().is_some()
}

fn override_dir() -> Option<PathBuf> {
    let raw = std::env::var(HOME_OVERRIDE).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}
