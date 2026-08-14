//! What a project shares with its worktrees, and what it keeps to itself.
//!
//! A fresh worktree with no `node_modules` is a worktree an agent cannot build
//! in, and copying one is minutes and gigabytes. These are linked instead, from
//! a list the project declares. The care here is all in the failure modes: a
//! link followed by `git worktree remove` deletes the *original*, so the links
//! come out before git touches the directory, and a name the policy may not hold
//! is refused rather than silently dropped.

use super::*;

/// Every directory name a worktree might hold a link to, across all
/// ecosystems.
///
/// This is a superset and it exists for one caller: `unlink_shared_artifacts`
/// runs while a worktree is being destroyed, when the policy that created the
/// links may already be unreadable. Unlinking only ever removes a symlink or a
/// junction, so naming too many directories costs a failed `symlink_metadata`
/// and naming too few leaks a link into `git worktree remove`, which is how a
/// real `node_modules` was once emptied. The asymmetry is why this list is
/// generous.
pub const SHARED_ARTIFACTS: [&str; 8] = [
    "node_modules",
    "target",
    ".venv",
    "venv",
    "vendor",
    ".gradle",
    "bin",
    "obj",
];

/// How a worktree takes one directory from the main checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareMode {
    /// One junction or symlink for the whole directory.
    ///
    /// Right for what only an install rewrites. A link to `node_modules` is
    /// wrong only if someone runs an install in the worktree, which is rare and
    /// visible; it is what makes a JavaScript worktree usable at all.
    Link,
    /// A hard link per file, minus what a build rewrites.
    ///
    /// Right for build output, the only thing big enough to be worth the walk
    /// and dangerous enough to need the exclusions. A link to `target` is wrong
    /// on the next build, because two worktrees of one package resolve to one
    /// artifact slot. Measured, not assumed: build A, edit and build B, then
    /// build A again — cargo reports A fresh in 0.01s and `target/debug/<name>`
    /// is B's binary. The agent then tests the other thread's code and is told
    /// it passed.
    Hardlink,
}

/// One directory a worktree takes from the main checkout, and the terms.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedDir {
    pub dir: String,
    pub mode: ShareMode,
    /// Globs, relative to `dir`, of what a build rewrites and a hard link must
    /// therefore not cover. `*` stops at a separator, `**` does not. Ignored
    /// for `Link`, where the whole directory is one link either way.
    #[serde(default)]
    pub exclude: Vec<String>,
    /// Cargo's layout is not expressible as globs: whether an artifact belongs
    /// to a workspace member is read from the manifests, not from its path.
    /// This turns that rule on, and it is additive with `exclude`.
    #[serde(default)]
    pub cargo_workspace: bool,
}

/// What a project shares with its worktrees.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArtifactPolicy {
    #[serde(default)]
    pub shared: Vec<SharedDir>,
}

/// Where a project may state its own policy, overriding detection entirely.
pub const POLICY_FILE: &str = ".boite/artifacts.json";

pub(super) fn link(dir: &str) -> SharedDir {
    SharedDir {
        dir: dir.to_string(),
        mode: ShareMode::Link,
        exclude: Vec::new(),
        cargo_workspace: false,
    }
}

/// What this project shares with its worktrees, read from the project or
/// worked out from what it is built with.
///
/// Detection covers the directories one link makes usable: an install
/// directory that a package manager wrote once and a build does not rewrite.
/// That is cheap wherever the filesystem is, because a link is one syscall
/// however big the directory is.
///
/// Build output is deliberately not detected, `target` included. Sharing it
/// needs a hard link per file, and on a filesystem with no copy-on-write to
/// fall back on that is one syscall per artifact: this repository's `target`
/// is around 42,000 of them, which measured 40 to 120 seconds per worktree on
/// NTFS, in front of a thread the user had just asked for. The pool of spares
/// was meant to absorb that and covers three launches; the fourth waited the
/// full time, and past 90 seconds the thread gives up and starts in the
/// project directory instead — the worktree it was promised arrives later and
/// is thrown away. A saved `cargo build` is not worth a launch that slow, and
/// it is only saved for a thread that builds at all.
///
/// A project where the trade goes the other way — a machine with reflinks, or
/// output small enough for the walk to be free — says so in the policy file,
/// which overrides all of this and is also what the MCP writes.
pub fn artifact_policy(repo: &Path) -> Vec<SharedDir> {
    if let Ok(text) = fs::read_to_string(repo.join(POLICY_FILE)) {
        if let Ok(policy) = serde_json::from_str::<ArtifactPolicy>(&text) {
            return policy.shared;
        }
        // A malformed file is not silently replaced by detection: someone wrote
        // it on purpose, and provisioning the wrong thing is what this guards.
        return Vec::new();
    }

    let mut shared = Vec::new();
    let has = |name: &str| repo.join(name).exists();

    // JavaScript. The install directory is the whole cost; build output is
    // small, fast to regenerate, and rewritten in place by most bundlers.
    if has("package.json") {
        shared.push(link("node_modules"));
    }
    // Python. Same shape, and a virtualenv holds absolute paths in its scripts,
    // so a link is also the only form of sharing that keeps it working.
    if has("pyproject.toml") || has("requirements.txt") || has("setup.py") {
        shared.push(link(".venv"));
        shared.push(link("venv"));
    }
    // Go and PHP vendoring, when it is committed to disk rather than fetched.
    if has("go.mod") || has("composer.json") {
        shared.push(link("vendor"));
    }
    // Gradle. `~/.gradle/caches` holds the downloads; the project-local
    // `.gradle` is per-build state worth sharing, `build/` is not.
    if has("build.gradle") || has("build.gradle.kts") || has("settings.gradle") {
        shared.push(link(".gradle"));
    }
    // .NET keeps its packages in `~/.nuget`. `bin` and `obj` are per-project
    // build output that the toolchain rewrites in place, so neither is shared
    // and a project that wants otherwise says so in the policy file.
    shared
}

/// A policy and the answer to the question an agent asks before touching it:
/// is this the project's own rule, or one nobody wrote down?
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePolicy {
    pub shared: Vec<SharedDir>,
    /// True when the policy file decided. It stays true for a file that failed
    /// to parse, because detection does not run behind one: an agent told
    /// `declared` there is looking at the file, which is where the mistake is.
    pub declared: bool,
}

/// The same answer `provision_shared_artifacts` acts on, plus where it came
/// from.
///
/// The two halves are inseparable for a reader. Detection is a guess this
/// codebase made about an ecosystem, and overwriting it costs nothing; a
/// declared policy is a decision someone made about their own project, and
/// overwriting that is how a rule tuned to a real build gets silently replaced
/// by one guessed from a manifest name.
pub fn effective_artifact_policy(repo: &Path) -> EffectivePolicy {
    EffectivePolicy {
        // Read rather than `exists`: a file that is there but unreadable is a
        // file detection ran behind, and this has to say the same thing
        // `artifact_policy` did or it describes a policy nobody is using.
        declared: fs::read_to_string(repo.join(POLICY_FILE)).is_ok(),
        shared: artifact_policy(repo),
    }
}

/// Writes a project's own policy, replacing whatever was there.
///
/// The names are checked here rather than only at provisioning time because the
/// two failures do not look alike. A rejected name at write time is an error the
/// author reads and fixes; the same name reaching `provision_shared_artifacts`
/// is skipped in silence, and the project quietly stops sharing the directory it
/// thought it had configured.
///
/// One plain component, which is stricter than `join` needs and deliberately
/// so: `dir` is also the name a worktree gets, and a policy that could name
/// `../..` or `C:\` would have the provisioner reach outside the two trees it
/// is allowed to touch.
pub fn write_artifact_policy(repo: &Path, policy: &ArtifactPolicy) -> Result<(), String> {
    for entry in &policy.shared {
        let mut parts = Path::new(&entry.dir).components();
        // The separator test is its own check because `components` does not
        // agree across platforms: a backslash is a separator on Windows and an
        // ordinary character elsewhere, so a policy written on Linux would carry
        // a name that only splits once it is read back on Windows.
        let plain = !entry.dir.contains(['/', '\\'])
            && matches!(parts.next(), Some(Component::Normal(_)))
            && parts.next().is_none();
        if !plain {
            return Err(format!(
                "'{}' is not a directory this can share: one plain name at the top of the \
                 repository, no separator, no '..' and no drive",
                entry.dir
            ));
        }
        // `Link` is one junction for the whole directory, so two worktrees
        // resolve to one artifact slot and a build in either overwrites the
        // other's output. `exclude` and `cargo_workspace` are how an author says
        // "a build rewrites part of this", and both are ignored under `Link`, so
        // the pair is never a policy anyone means: it is the corruption this
        // file's own `ShareMode` doc measured, declared by hand.
        if entry.mode == ShareMode::Link && (entry.cargo_workspace || !entry.exclude.is_empty()) {
            return Err(format!(
                "'{}' asks for 'link' with build-output exclusions, which link ignores. Build \
                 output has to be 'hardlink', or two worktrees share one artifact slot and each \
                 build overwrites the other's.",
                entry.dir
            ));
        }
        // The same mistake with nothing to spot it by: a bare `target` in a cargo
        // project is build output whether or not the author filled in the flags.
        if entry.mode == ShareMode::Link && entry.dir == "target" && repo.join("Cargo.toml").is_file()
        {
            return Err(
                "'target' is cargo's build output and cannot be shared with 'link': two worktrees \
                 would resolve to one artifact slot. Use 'hardlink', which is what detection \
                 writes."
                    .to_string(),
            );
        }
    }
    let path = repo.join(POLICY_FILE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    // Pretty, and committed to the repository more often than not: this file is
    // read by whoever wonders why their worktree has a `target` and edited by
    // hand as often as it is written here.
    let text = serde_json::to_string_pretty(policy).map_err(|e| e.to_string())?;
    fs::write(&path, text + "\n").map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Whether a relative path matches a glob. `*` stops at a separator, `**` does
/// not.
pub(super) fn glob_matches(pattern: &str, path: &str) -> bool {
    fn seg(p: &[&str], s: &[&str]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some(&"**") => {
                // `**` swallows any number of segments, the empty one included.
                (0..=s.len()).any(|i| seg(&p[1..], &s[i..]))
            }
            Some(pat) => match s.first() {
                Some(part) if star_matches(pat, part) => seg(&p[1..], &s[1..]),
                _ => false,
            },
        }
    }
    // The end of the pattern is anchored at the end of the name, and the start
    // at the start. Only the segments in between are searched left to right,
    // which is what makes `*.js` match `a.js.js`: the trailing literal is
    // matched from the right, never by the first `find` that happens to hit.
    fn star_matches(pattern: &str, name: &str) -> bool {
        let parts: Vec<&str> = pattern.split('*').collect();
        // No star at all is a literal, and a literal matches the whole name.
        if parts.len() == 1 {
            return pattern == name;
        }
        let first = parts[0];
        let last = parts[parts.len() - 1];
        if !name.starts_with(first) || !name.ends_with(last) {
            return false;
        }
        // Anchors that would have to share characters do not both hold.
        if first.len() + last.len() > name.len() {
            return false;
        }
        let mut rest = &name[first.len()..name.len() - last.len()];
        for part in &parts[1..parts.len() - 1] {
            if part.is_empty() {
                continue;
            }
            let Some(at) = rest.find(part) else {
                return false;
            };
            rest = &rest[at + part.len()..];
        }
        true
    }
    let p: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let s: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    seg(&p, &s)
}

/// Gives the worktree its own copy of the main checkout's heavy directories,
/// cloned rather than duplicated where the filesystem can. Returns the names
/// actually provisioned.
///
/// Copy-on-write is what makes this affordable: on APFS this repository's 32 GB
/// `target` clones in 13 seconds and costs no disk at all until one of the two
/// copies is written to. That is the whole reason the directories can be
/// separate now — the previous symlink was not chosen for speed over
/// correctness, it was chosen because a real copy of `target` was unthinkable.
///
/// Best-effort by design: what cannot be provisioned costs disk and time, not
/// correctness, so a failure is skipped rather than raised.
pub fn provision_shared_artifacts(repo: &Path, worktree: &Path) -> Vec<String> {
    let mut done = Vec::new();
    for entry in artifact_policy(repo) {
        // The name reaches `join` from a file the project controls, so it is
        // treated the way every other stored path here is: a plain name, one
        // level, or nothing.
        if entry.dir.is_empty()
            || Path::new(&entry.dir)
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            continue;
        }
        let src = repo.join(&entry.dir);
        if !src.is_dir() {
            continue;
        }
        let dst = worktree.join(&entry.dir);
        // A real directory of that name in the worktree is tracked content, and
        // replacing it would delete work. Only an absent path is ours to fill.
        if fs::symlink_metadata(&dst).is_ok() {
            continue;
        }
        if clone_dir(&src, &dst).is_ok() {
            done.push(entry.dir.clone());
            continue;
        }
        // No copy-on-write here: ext4, a network volume, Windows outside a dev
        // drive.
        match entry.mode {
            ShareMode::Hardlink => {
                // Hard links get most of what a clone gets, at file granularity
                // instead of directory granularity: the dependency artifacts
                // are identical across worktrees and the toolchain never
                // rewrites them, so two names for one set of blocks is exactly
                // right for them. What a build does rewrite is left out and
                // regenerated here, which is the cheap half of a build.
                if hardlink_build_output(repo, &src, &dst, &entry).is_ok() {
                    done.push(entry.dir.clone());
                }
            }
            ShareMode::Link => {
                if link_dir(&src, &dst).is_ok() {
                    done.push(entry.dir.clone());
                }
            }
        }
    }
    done
}

/// Clones a directory tree copy-on-write, or fails without writing anything.
///
/// Refusing is the contract, and it is the hard part. A clone that quietly
/// degrades to a byte copy is worse than no clone at all: it writes a real
/// 32 GB where the caller budgeted nothing, and it reports success, so nothing
/// downstream ever learns the volume could not do this.
#[cfg(target_os = "macos")]
fn clone_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let cstr = |p: &Path| {
        CString::new(p.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::other("path contains a nul byte"))
    };
    let (s, d) = (cstr(src)?, cstr(dst)?);
    // The syscall, not `cp -c`. `cp -c` was the obvious choice and it is the
    // wrong one: measured, it exits 0 and copies every byte both when the two
    // paths are on different volumes and when the volume is not APFS, so it
    // can never be used to ask whether cloning is possible. `clonefile` clones
    // a directory hierarchy in one call and reports EXDEV or ENOTSUP instead
    // of pretending.
    if unsafe { libc::clonefile(s.as_ptr(), d.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    let _ = fs::remove_dir_all(dst);
    Err(err)
}

#[cfg(target_os = "linux")]
fn clone_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    // `always`, never `auto`: `auto` is the same trap as `cp -c`, degrading to
    // a full byte copy on ext4 while reporting success. `always` is documented
    // to fail instead, and that includes the cross-filesystem case, so this
    // stays a real capability probe.
    let mut cmd = Command::new("cp");
    cmd.arg("--reflink=always").arg("-r").arg(src).arg(dst);
    let status = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        return Ok(());
    }
    // A refusal partway through still leaves a tree behind, and every later
    // caller would read that as "already provisioned" and skip the fallback.
    let _ = fs::remove_dir_all(dst);
    Err(std::io::Error::other("clone failed"))
}

/// Windows has no block cloning outside a ReFS dev drive, and no command-line
/// verb for it. The install-time directories fall through to a junction as
/// before; `target` goes through `hardlink_build_output` instead.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clone_dir(_src: &Path, _dst: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("no copy-on-write on this platform"))
}

/// The packages this repository builds itself, spelled the way cargo spells
/// them in artifact names.
///
/// Cargo turns `-` into `_` for library artifacts and leaves it alone for
/// binaries and fingerprint directories, so both spellings go in. An explicit
/// `[lib] name` overrides the package name and is collected too.
///
/// Hand-read rather than pulled through a TOML crate or `cargo metadata`: two
/// keys are needed, `name` and `members`, and neither a new dependency in the
/// core crate nor a process spawn on the worktree-open path is worth that.
/// Anything this cannot make sense of yields an empty set, and an empty set
/// makes the caller provision nothing — the direction that costs a recompile
/// rather than correctness.
pub(super) fn workspace_package_names(repo: &Path) -> HashSet<String> {
    fn value_in(text: &str, section: &str, key: &str) -> Option<String> {
        let mut current = "";
        for line in text.lines() {
            let t = line.trim();
            if let Some(header) = t.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                current = header.trim_matches('[').trim_matches(']');
                continue;
            }
            if current != section {
                continue;
            }
            if let Some((k, v)) = t.split_once('=') {
                if k.trim() == key {
                    return Some(v.trim().trim_matches('"').to_string());
                }
            }
        }
        None
    }

    fn add(names: &mut HashSet<String>, name: &str) {
        if name.is_empty() {
            return;
        }
        names.insert(name.replace('-', "_"));
        names.insert(name.to_string());
    }

    fn collect_manifest(names: &mut HashSet<String>, dir: &Path) {
        let Ok(text) = fs::read_to_string(dir.join("Cargo.toml")) else {
            return;
        };
        if let Some(n) = value_in(&text, "package", "name") {
            add(names, &n);
        }
        if let Some(n) = value_in(&text, "lib", "name") {
            add(names, &n);
        }
    }

    let mut names = HashSet::new();
    collect_manifest(&mut names, repo);

    // `members` is a list and cargo formats it across lines as often as not, so
    // it is read as everything between the `=` and the closing bracket rather
    // than off a single line.
    if let Ok(text) = fs::read_to_string(repo.join("Cargo.toml")) {
        let mut in_workspace = false;
        let mut buf = String::new();
        let mut collecting = false;
        for line in text.lines() {
            let t = line.trim();
            if let Some(header) = t.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                in_workspace = header == "workspace";
                continue;
            }
            if !in_workspace {
                continue;
            }
            if !collecting {
                if let Some((k, v)) = t.split_once('=') {
                    if k.trim() == "members" {
                        collecting = true;
                        buf.push_str(v);
                    }
                }
            } else {
                buf.push_str(t);
            }
            if collecting && buf.contains(']') {
                break;
            }
        }
        for member in buf.trim().trim_matches(['[', ']']).split(',') {
            let m = member.trim().trim_matches('"');
            // A glob member (`crates/*`) is not expanded: every directory that
            // holds a manifest is read instead, which covers the glob and costs
            // one readdir.
            if m.is_empty() {
                continue;
            }
            if m.contains('*') {
                let Some(parent) = m.split('*').next() else {
                    continue;
                };
                if let Ok(entries) = fs::read_dir(repo.join(parent.trim_end_matches('/'))) {
                    for e in entries.flatten() {
                        collect_manifest(&mut names, &e.path());
                    }
                }
                continue;
            }
            collect_manifest(&mut names, &repo.join(m));
        }
    }

    names
}

/// Whether an artifact file or directory belongs to one of this repository's
/// own packages.
///
/// Cargo suffixes almost everything with `-<16 hex>`, so the name is compared
/// with that stripped. A leading `lib` goes too: `libboite_core-<hash>.rlib`
/// and `boite-core-<hash>/` are the same package wearing two spellings.
pub(super) fn is_local_artifact(name: &str, locals: &HashSet<String>) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    let base = match stem.rsplit_once('-') {
        Some((head, tail)) if tail.len() == 16 && tail.chars().all(|c| c.is_ascii_hexdigit()) => {
            head
        }
        _ => stem,
    };
    locals.contains(base)
        || base
            .strip_prefix("lib")
            .is_some_and(|s| locals.contains(s))
}

/// Whether a path inside a shared build directory is one the worktree has to
/// own outright.
///
/// Everything a build rewrites stays out: a hard link is not copy-on-write, so
/// writing through one writes the main checkout's copy too. What is left is the
/// dependency artifacts, which are the bulk of the tree and which the toolchain
/// only ever creates, never edits.
///
/// `rel` is relative to the shared directory itself, which is what the policy
/// file's globs are documented against.
pub(super) fn is_mutable_build_artifact(
    rel: &Path,
    is_dir: bool,
    entry: &SharedDir,
    locals: &HashSet<String>,
) -> bool {
    let parts: Vec<&str> = rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    if !entry.exclude.is_empty() {
        let joined = parts.join("/");
        if entry.exclude.iter().any(|g| glob_matches(g, &joined)) {
            return true;
        }
    }

    if !entry.cargo_workspace {
        return false;
    }

    // Cargo's own lock files, wherever they sit. Linking a lock would make two
    // worktrees block on each other for no reason at all.
    if parts
        .last()
        .is_some_and(|last| last.starts_with(".cargo-") && last.ends_with("lock"))
    {
        return true;
    }
    // Per-worktree by nature, and the one place cargo does rewrite in place.
    if parts.contains(&"incremental") {
        return true;
    }
    // A *file* sitting directly in `debug/` or `release/` is an uplifted final
    // artifact: `target/debug/boite.exe` has no hash in its name, so both
    // worktrees would claim the same one. This is the exact collision a shared
    // target directory produces, and the reason the test below exists. The
    // directories at that level — `deps`, `build`, `.fingerprint` — are the
    // ones worth linking, so the distinction is not cosmetic.
    if parts.len() == 2 && !is_dir {
        return true;
    }
    // Inside `deps/`, `build/` and `.fingerprint/`, only what this repository
    // builds itself. Registry crates are identical across worktrees.
    if parts.len() >= 3 {
        match parts[1] {
            "deps" | "build" | ".fingerprint" => return is_local_artifact(parts[2], locals),
            _ => {}
        }
    }
    false
}

/// Gives the worktree a `target` made of hard links to the main checkout's
/// dependency artifacts, and nothing else.
///
/// This is the fallback for every filesystem without copy-on-write — NTFS and
/// ext4 both — and it buys the same thing a clone does: measured on this
/// repository, 27 GB of `target` provisioned in 61 seconds for 27 MB of real
/// disk, the directory entries and nothing more.
///
/// It is weaker than a clone in one way that decides the whole shape of the
/// function. A clone diverges on the first write; a hard link does not, so a
/// file written through one is written in the main checkout too. Hence the
/// exclusions: what a build rewrites is never linked, and the worktree
/// recompiles its own packages. That is the fast part of a build anyway — the
/// dependencies are what cost minutes.
fn hardlink_build_output(
    repo: &Path,
    src: &Path,
    dst: &Path,
    entry: &SharedDir,
) -> std::io::Result<()> {
    let locals = if entry.cargo_workspace {
        let names = workspace_package_names(repo);
        // No package list means no way to tell a local artifact from a vendored
        // one, and linking the wrong file hands this worktree another's binary.
        if names.is_empty() {
            return Err(std::io::Error::other("cannot identify the workspace packages"));
        }
        names
    } else {
        // A policy that names neither a cargo workspace nor a single exclusion
        // is asking for the whole directory to be linked. That is the author's
        // call to make, and it is only safe for output nothing rewrites.
        HashSet::new()
    };

    // Single file on purpose, and it was measured rather than assumed: linking
    // this repository's `target` on 8 threads came back 26s against 29s for one,
    // because `CreateHardLink` waits on the volume and the MFT rather than on a
    // round trip. Ten percent is not worth a worker pool, a shared error slot
    // and a probe that has to stay outside them. What actually takes this cost
    // off a launch is the pool of ready worktrees, not doing it faster.
    fn walk(
        src: &Path,
        dst: &Path,
        rel: &Path,
        entry: &SharedDir,
        locals: &HashSet<String>,
        linked: &mut usize,
    ) -> std::io::Result<()> {
        fs::create_dir_all(dst)?;
        for child in fs::read_dir(src)? {
            let child = child?;
            let name = child.file_name();
            let from = child.path();
            let to = dst.join(&name);
            let ty = child.file_type()?;
            let child_rel = rel.join(&name);
            if is_mutable_build_artifact(&child_rel, ty.is_dir(), entry, locals) {
                continue;
            }
            if ty.is_dir() {
                walk(&from, &to, &child_rel, entry, locals, linked)?;
            } else if ty.is_file() {
                // The first link is the capability probe: hard links do not
                // cross volumes, and a worktree on another drive has to fail
                // here rather than halfway through 25 000 files.
                fs::hard_link(&from, &to)?;
                *linked += 1;
            }
            // Symlinks are skipped: recreating one needs to know whether it
            // pointed at a file or a directory, and nothing a build tool puts
            // in its output directory is one.
        }
        Ok(())
    }

    let mut linked = 0usize;
    let result = walk(src, dst, Path::new(""), entry, &locals, &mut linked);

    if result.is_err() || linked == 0 {
        // A half-linked tree reads as "already provisioned" to every later
        // caller and would never be retried or completed.
        let _ = fs::remove_dir_all(dst);
        return result.and(Err(std::io::Error::other("nothing could be linked")));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn link_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    // A junction rather than a symlink: symlink creation needs either developer
    // mode or elevation on Windows, junctions need neither.
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "mklink", "/J"])
        .arg(dst)
        .arg(src)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Without this the console host paints a real window for every link,
        // so opening a worktree flashes one per shared directory.
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let status = cmd.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("mklink failed"))
    }
}

// Both arms are `pub(crate)`, and that is not decoration: `worktree.rs` reaches
// this from a test and `session::shared` points a store at another one with it,
// so an arm left private compiles on the platform whose twin is public and
// nowhere else. The split raised one and missed the other, and it took a Linux
// runner to say so.
#[cfg(not(windows))]
pub(crate) fn link_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

/// Removes the links, never what they point at.
///
/// This has to run before `git worktree remove`. Git deletes the directory
/// tree, and on Windows it descends into a junction and empties the *target* —
/// which is the main checkout's `node_modules`. That is not theoretical: it is
/// how one was destroyed during this feature's own development.
///
/// A cloned directory is deliberately not touched here: it belongs to this
/// worktree alone, nothing outside is reachable through it, and git deleting it
/// with the rest of the tree is the correct outcome. Copy-on-write means that
/// frees only the blocks the two copies stopped sharing.
pub fn unlink_shared_artifacts(repo: &Path, worktree: &Path) {
    // The static list alone is not enough since a project can declare its own
    // directories: a `Link` entry naming anything outside the eight below would
    // survive this and be handed to git, which is the destruction this whole
    // function exists to prevent. The policy is read here rather than passed in
    // because an unreadable one has to degrade to the static list instead of
    // skipping the unlink entirely.
    let mut names: Vec<String> = SHARED_ARTIFACTS.iter().map(|n| n.to_string()).collect();
    for entry in artifact_policy(repo) {
        if entry.dir.is_empty()
            || entry.dir.contains(['/', '\\'])
            || names.iter().any(|name| name == &entry.dir)
        {
            continue;
        }
        names.push(entry.dir);
    }
    for name in names {
        let dst = worktree.join(&name);
        let Ok(meta) = fs::symlink_metadata(&dst) else {
            continue;
        };
        if !meta.file_type().is_symlink() {
            // A real directory: whatever it is, it is not ours to delete.
            continue;
        }
        // `remove_dir` unlinks the junction or directory symlink itself and
        // never follows it. `remove_dir_all` would be the bug this exists to
        // prevent.
        let _ = fs::remove_dir(&dst).or_else(|_| fs::remove_file(&dst));
    }
}

