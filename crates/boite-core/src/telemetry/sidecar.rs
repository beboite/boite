//! Local consent and identifiers, next to `boite.db`.
//!
//! Not the settings blob. `settings.get` is read by the agent endpoint, and
//! the machines sync would copy an `install_id` from one PC onto another and
//! merge two PostHog installations. One sidecar file per data directory is
//! one install.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "telemetry.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Sidecar {
    #[serde(default = "default_true")]
    pub mode_a_enabled: bool,
    #[serde(default)]
    pub mode_b_enabled: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub install_id: String,
    /// Install identifiers whose server-side Mode B data still needs to be
    /// deleted. Kept locally until `/forget` succeeds so an offline opt-out is
    /// both immediate and retryable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_forget_install_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub anonymous_id: String,
    #[serde(default)]
    pub onboarding_completed: bool,
    /// Whether the one-shot `first_run` event has already been emitted.
    ///
    /// Existing installations default to false and will report a `first_run`
    /// on their next launch after they answer the overlay, so the event means
    /// "first launch that knew how to report one".
    #[serde(default)]
    pub first_run_reported: bool,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            mode_a_enabled: true,
            mode_b_enabled: false,
            install_id: String::new(),
            pending_forget_install_ids: Vec::new(),
            anonymous_id: String::new(),
            onboarding_completed: false,
            first_run_reported: false,
        }
    }
}

fn default_true() -> bool {
    true
}

pub fn path_in(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Loads the sidecar, or a default when the file is missing or unreadable.
///
/// A corrupt file is treated as a fresh sidecar rather than refusing to
/// start: telemetry is optional, the window is not.
pub fn load(path: &Path) -> Sidecar {
    let Ok(bytes) = fs::read(path) else {
        return Sidecar::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Writes the sidecar next to the database, replacing the previous file.
pub fn save(path: &Path, sidecar: &Sidecar) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("telemetry sidecar dir: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(sidecar)
        .map_err(|e| format!("telemetry sidecar encode: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("telemetry sidecar write: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("telemetry sidecar replace: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "boite-telemetry-sidecar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join(FILE_NAME)
    }

    #[test]
    fn missing_file_is_a_fresh_sidecar_with_onboarding_open() {
        let path = tmp();
        let loaded = load(&path);
        assert!(!loaded.onboarding_completed);
        assert!(loaded.mode_a_enabled);
        assert!(!loaded.mode_b_enabled);
        assert!(loaded.install_id.is_empty());
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn round_trip_preserves_ids() {
        let path = tmp();
        let mut sidecar = Sidecar::default();
        sidecar.onboarding_completed = true;
        sidecar.mode_b_enabled = true;
        sidecar.install_id = "550e8400-e29b-41d4-a716-446655440000".into();
        sidecar.anonymous_id = "797f20fe-94de-4e89-98a2-ae3a3273ad1e".into();
        save(&path, &sidecar).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.install_id, sidecar.install_id);
        assert_eq!(loaded.anonymous_id, sidecar.anonymous_id);
        assert!(loaded.mode_b_enabled);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(path.parent().unwrap());
    }

    #[test]
    fn corrupt_file_does_not_panic() {
        let path = tmp();
        fs::write(&path, b"not json {").unwrap();
        let loaded = load(&path);
        assert!(!loaded.onboarding_completed);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(path.parent().unwrap());
    }
}
