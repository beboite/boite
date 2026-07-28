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

    /// The registered roots, as strings.
    ///
    /// Read by the new-project path, which needs their parent folders: a
    /// project is allowed to be created next to the ones that already exist.
    /// Nothing else should reach for this — every other caller wants
    /// `ensure_allowed`, which answers the question instead of handing over the
    /// list to be re-implemented against.
    pub fn snapshot(&self) -> Vec<String> {
        self.roots
            .lock()
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect()
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

    // For write targets that may not exist yet: validate the parent dir. When
    // the target DOES exist it is canonicalized too — a symlink sitting in an
    // allowed directory can point anywhere, and the write follows it, so the
    // parent check alone is not a boundary.
    pub fn ensure_allowed_for_write(&self, path: &str) -> Result<(), String> {
        let p = Path::new(path);
        let parent = p
            .parent()
            .ok_or_else(|| "invalid path: no parent".to_string())?;
        let canonical = std::fs::canonicalize(parent)
            .map_err(|e| format!("invalid path: {e}"))?;
        if !self.is_allowed(&canonical) {
            return Err("path is outside registered project roots".into());
        }
        if std::fs::symlink_metadata(p).is_ok() {
            let target = std::fs::canonicalize(p)
                .map_err(|e| format!("invalid path: {e}"))?;
            if !self.is_allowed(&target) {
                return Err("path is outside registered project roots".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // Keyed by pid and thread id so `cargo test` running these in parallel
    // never has two cases sharing a directory.
    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "boite-scope-{}-{}-{:?}",
                tag,
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.root.join(rel);
            fs::create_dir_all(&p).unwrap();
            p
        }

        fn file(&self, rel: &str) -> PathBuf {
            let p = self.root.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, b"x").unwrap();
            p
        }

        fn s(p: &Path) -> String {
            p.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn nothing_is_allowed_before_any_root_is_registered() {
        let tree = TempTree::new("empty");
        let inside = tree.file("project/a.txt");
        let roots = ProjectRoots::default();
        assert!(roots.ensure_allowed(&TempTree::s(&inside)).is_err());
    }

    #[test]
    fn paths_under_a_registered_root_are_allowed() {
        let tree = TempTree::new("allow");
        let project = tree.dir("project");
        let inside = tree.file("project/nested/deep.txt");
        let roots = ProjectRoots::default();
        roots.replace(vec![TempTree::s(&project)]);

        assert!(roots.ensure_allowed(&TempTree::s(&inside)).is_ok());
        assert!(roots.ensure_allowed(&TempTree::s(&project)).is_ok());
    }

    #[test]
    fn a_sibling_directory_is_not_allowed() {
        let tree = TempTree::new("sibling");
        let project = tree.dir("project");
        let secret = tree.file("elsewhere/id_rsa");
        let roots = ProjectRoots::default();
        roots.replace(vec![TempTree::s(&project)]);

        assert!(roots.ensure_allowed(&TempTree::s(&secret)).is_err());
    }

    #[test]
    fn dot_dot_cannot_climb_out_of_a_root() {
        // The whole point of canonicalizing first: "<root>/../elsewhere/id_rsa"
        // is inside the root textually and outside it in reality.
        let tree = TempTree::new("dotdot");
        let project = tree.dir("project");
        tree.file("elsewhere/id_rsa");
        let roots = ProjectRoots::default();
        roots.replace(vec![TempTree::s(&project)]);

        let climb = project.join("..").join("elsewhere").join("id_rsa");
        assert!(roots.ensure_allowed(&TempTree::s(&climb)).is_err());
    }

    #[test]
    fn replace_swaps_the_root_set_rather_than_adding_to_it() {
        let tree = TempTree::new("replace");
        let first = tree.dir("first");
        let second = tree.dir("second");
        let in_first = tree.file("first/a.txt");
        let in_second = tree.file("second/b.txt");
        let roots = ProjectRoots::default();

        roots.replace(vec![TempTree::s(&first)]);
        assert!(roots.ensure_allowed(&TempTree::s(&in_first)).is_ok());

        roots.replace(vec![TempTree::s(&second)]);
        assert!(roots.ensure_allowed(&TempTree::s(&in_second)).is_ok());
        assert!(
            roots.ensure_allowed(&TempTree::s(&in_first)).is_err(),
            "a removed project must lose access immediately"
        );
    }

    #[test]
    fn unresolvable_roots_are_dropped_instead_of_matching_everything() {
        let tree = TempTree::new("ghost");
        let inside = tree.file("project/a.txt");
        let roots = ProjectRoots::default();
        roots.replace(vec![TempTree::s(&tree.root.join("does-not-exist"))]);

        assert!(roots.ensure_allowed(&TempTree::s(&inside)).is_err());
    }

    #[test]
    fn writes_are_allowed_to_a_file_that_does_not_exist_yet() {
        let tree = TempTree::new("write-new");
        let project = tree.dir("project");
        let roots = ProjectRoots::default();
        roots.replace(vec![TempTree::s(&project)]);

        let target = project.join("brand-new.txt");
        assert!(roots.ensure_allowed_for_write(&TempTree::s(&target)).is_ok());
        // ...but only when its parent is inside a root.
        let outside = tree.root.join("loose.txt");
        assert!(roots
            .ensure_allowed_for_write(&TempTree::s(&outside))
            .is_err());
    }

    #[test]
    fn write_target_missing_parent_is_rejected() {
        let tree = TempTree::new("write-orphan");
        let project = tree.dir("project");
        let roots = ProjectRoots::default();
        roots.replace(vec![TempTree::s(&project)]);

        let nested = project.join("no-such-dir").join("file.txt");
        assert!(roots
            .ensure_allowed_for_write(&TempTree::s(&nested))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_a_root_cannot_redirect_a_write_outside_it() {
        // Regression: checking only the parent directory let an attacker drop a
        // symlink in an allowed folder and have the write follow it anywhere.
        let tree = TempTree::new("symlink");
        let project = tree.dir("project");
        let secret = tree.file("elsewhere/id_rsa");
        let link = project.join("innocent.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let roots = ProjectRoots::default();
        roots.replace(vec![TempTree::s(&project)]);

        assert!(roots.ensure_allowed_for_write(&TempTree::s(&link)).is_err());
        assert!(roots.ensure_allowed(&TempTree::s(&link)).is_err());
    }
}
