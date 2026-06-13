use std::collections::HashSet;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;

// Filesystem trust boundary for IPC commands. The strict CSP makes webview
// compromise unlikely, but commands are the actual boundary in Tauri:
// without this, read/write/read_dir/git accepted any absolute path and one
// XSS could read SSH keys or overwrite startup files anywhere on disk.
#[derive(Default)]
pub struct ProjectRoots {
    roots: Mutex<HashSet<PathBuf>>,
}

impl ProjectRoots {
    pub fn replace(&self, roots: Vec<String>) {
        let canonical: HashSet<PathBuf> = roots
            .iter()
            .filter_map(|r| std::fs::canonicalize(r).ok())
            .collect();
        *self.roots.lock() = canonical;
    }

    fn is_allowed(&self, canonical: &Path) -> bool {
        let roots = self.roots.lock();
        roots.iter().any(|root| canonical.starts_with(root))
    }

    // For existing paths: canonicalize (kills `..` and symlink tricks) and
    // require the result to live under a registered project root.
    pub fn ensure_allowed(&self, path: &str) -> Result<(), String> {
        let canonical = std::fs::canonicalize(path)
            .map_err(|e| format!("invalid path: {e}"))?;
        if self.is_allowed(&canonical) {
            return Ok(());
        }
        Err("path is outside registered project roots".into())
    }

    // For write targets that may not exist yet: validate the parent dir.
    pub fn ensure_allowed_for_write(&self, path: &str) -> Result<(), String> {
        let p = Path::new(path);
        let parent = p
            .parent()
            .ok_or_else(|| "invalid path: no parent".to_string())?;
        let canonical = std::fs::canonicalize(parent)
            .map_err(|e| format!("invalid path: {e}"))?;
        if self.is_allowed(&canonical) {
            return Ok(());
        }
        Err("path is outside registered project roots".into())
    }
}
