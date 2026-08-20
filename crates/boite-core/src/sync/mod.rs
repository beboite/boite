//! Carrying an agent's configuration from one computer to another.
//!
//! Working on two machines with the same agents means setting the same things
//! up twice: the default model, the plugins, the MCP servers, and above all the
//! shared instruction tree in `~/.agents`. None of it follows. This module makes
//! it follow, through a private git repository the user owns and points Boite
//! at — no Boite server, no account, and no credential stored here: git resolves
//! authentication on the machine the threads run on, exactly as it does for
//! every other repository there.
//!
//! Four rules hold the design together, and each one ships broken if forgotten.
//!
//! **The manifest is an allowlist of named files plus one tree**, never a
//! directory minus a denylist. `~/.claude` is not a source; `~/.claude/settings.json`
//! is. See `manifest`.
//!
//! **A file is parsed only if it declares a field rule, and it is never written
//! back.** `serde_json` here has no `preserve_order` and one file in scope is
//! JSONC. Redaction substitutes a value's own text; it does not rewrite a
//! document. See `portable`.
//!
//! **A secret never leaves.** A credential inside a file that is in scope — and
//! there is one — is swapped for a placeholder keyed on the field it came from,
//! so two machines produce identical bytes and a pull restores what was already
//! here rather than blanking it.
//!
//! **A difference is never overwritten.** What differs on both sides goes to a
//! merge tool that can keep both, the first sync on a machine that already has
//! configuration included. See `plan`, where the base's absence is what makes
//! that fall out of the model rather than being a special case.

pub mod apply;
pub mod home;
pub mod jobs;
pub mod manifest;
pub mod mirror;
pub mod plan;
pub mod portable;
pub mod scan;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use jobs::Phase;

/// What the user switched on, read from the settings row the host keeps.
///
/// Passed in rather than read here: a capability that reached into the store
/// from the work thread would be a second place the answer to "is this source
/// on" lives, and the two would drift.
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub remote_url: Option<String>,
    pub enabled: Vec<String>,
}

impl Config {
    fn enabled_ids(&self) -> Vec<&str> {
        self.enabled.iter().map(String::as_str).collect()
    }
}

/// One row in the settings panel.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRow {
    pub id: String,
    /// The files this source covers, home-relative. Empty when nothing is
    /// declared for it yet.
    pub paths: Vec<String>,
    /// False when Boite does not know where this agent keeps its configuration.
    /// A declared answer rather than a gap: ten agents, ten answers.
    pub supported: bool,
    /// Whether anything is here now. Absence does not disable the switch — a
    /// configuration arriving before its agent is how a new machine is set up.
    pub present_here: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Whether this machine can sync at all. Git has to be here.
    pub supported: bool,
    pub remote_url: Option<String>,
    pub branch: Option<String>,
    /// Whether this machine has ever finished a sync. False means the next
    /// comparison has an empty base, which is what puts every difference in
    /// front of the user instead of adopting one side.
    pub has_base: bool,
    pub job: jobs::Snapshot,
}

/// Every source and what this machine says about it.
pub fn sources_blocking(home: Option<&Path>) -> Vec<SourceRow> {
    manifest::SOURCES
        .iter()
        .map(|entry| SourceRow {
            id: entry.id.to_string(),
            paths: entry.sources.iter().map(|source| source.path.to_string()).collect(),
            supported: !entry.sources.is_empty(),
            present_here: home
                .map(|home| {
                    entry.sources.iter().any(|source| {
                        manifest::resolve(home, source)
                            .map(|path| std::fs::symlink_metadata(path).is_ok())
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false),
        })
        .collect()
}

pub fn status_blocking(home: Option<&Path>, config: &Config) -> Status {
    let mut job = jobs::snapshot();
    let supported = git_is_here();
    job.supported = supported;
    let dir = home.map(mirror::mirror_dir);
    let cloned = dir.as_deref().filter(|dir| dir.join(".git").exists());
    Status {
        supported,
        // The mirror's own remote wins when there is one, so a panel never shows
        // an address the next fetch will not use.
        remote_url: cloned.and_then(mirror::remote_url).or_else(|| config.remote_url.clone()),
        branch: cloned.map(mirror::branch),
        has_base: cloned.and_then(mirror::base).is_some(),
        job,
    }
}

pub fn probe_blocking(url: &str) -> mirror::Probe {
    mirror::probe(url)
}

pub fn conflicts_blocking() -> Vec<plan::Divergence> {
    jobs::conflicts()
}

pub fn cancel() -> bool {
    jobs::cancel()
}

pub fn dismiss() {
    jobs::dismiss()
}

pub fn repair_blocking(home: &Path) -> Result<(), String> {
    mirror::repair(&mirror::mirror_dir(home)).map_err(|failed| failed.message())
}

/// Fetches, compares, writes what only one side changed, and reports the rest.
///
/// Answers at once with the snapshot; the work runs on a thread of its own.
/// `push` is false for the pull a launch does, so opening Boite never sends
/// anything nobody asked it to send.
pub fn start_blocking(home: &Path, config: &Config, push: bool) -> Result<jobs::Snapshot, String> {
    if !git_is_here() {
        return Err("syncing needs git on this machine, and none was found".to_string());
    }
    if config.remote_url.is_none() && mirror::remote_url(&mirror::mirror_dir(home)).is_none() {
        // Asked before the work rather than after, so no job row appears and no
        // spinner turns for something that was never going to start.
        return Err(mirror::Failed::NoRemote.message());
    }
    let cancel = jobs::start()?;
    let home = home.to_path_buf();
    let config = config.clone();
    let spawned = std::thread::Builder::new()
        .name("boite-sync".to_string())
        .spawn(move || run(&home, &config, push, &cancel));
    if let Err(error) = spawned {
        jobs::finish(Phase::Failed, Some(format!("a sync thread could not start: {error}")), None);
    }
    Ok(jobs::snapshot())
}

/// Puts one merged file where it goes, on this machine and in the mirror.
///
/// The only call that writes arbitrary bytes, and it writes one file. That is
/// what makes an abandoned merge safe: at every instant a file was either
/// applied — holding exactly what the user saw — or was never touched. Nothing
/// here reaches the network; the batch is sent when the user is done.
pub fn resolve_blocking(
    home: &Path,
    config: &Config,
    path: &str,
    content: &str,
) -> Result<jobs::Snapshot, String> {
    if !jobs::is_waiting(path) {
        // Only a file the comparison put in front of the user. Free-form this
        // would be a write-anywhere primitive reachable from a webview.
        return Err(format!("{path} is not one of the files waiting to be merged"));
    }
    let mut one = mirror::Files::new();
    one.insert(path.to_string(), content.as_bytes().to_vec());
    // Written to the machine and remembered, not staged into the mirror. The
    // mirror is reset to the remote at the top of every run, so anything left
    // sitting in it would either be discarded or refuse the run as unfinished
    // work. The next scan reads the merged file back off this machine, and the
    // settled list is what tells the comparison it was already decided.
    let outcome = apply::apply(home, &mirror::backup_dir(home), &config.enabled_ids(), &one);
    jobs::note_apply(&outcome);
    if let Some(refused) = outcome.refused.first() {
        return Err(format!("{}: {}", refused.path, refused.reason));
    }
    jobs::settle_one(path, false);
    Ok(jobs::snapshot())
}

/// Leaves a file exactly as both sides have it. The next comparison asks again.
pub fn skip_blocking(path: &str) -> Result<jobs::Snapshot, String> {
    if !jobs::settle_one(path, true) {
        return Err(format!("{path} is not one of the files waiting to be merged"));
    }
    Ok(jobs::snapshot())
}

fn run(home: &Path, config: &Config, push: bool, cancel: &Arc<AtomicBool>) {
    match work(home, config, push, cancel) {
        Ok(outcome) if outcome.needs_merge => {
            jobs::finish(Phase::NeedsMerge, None, outcome.pushed)
        }
        Ok(outcome) => jobs::finish(Phase::Done, None, outcome.pushed),
        Err(Stopped::Cancelled) => jobs::finish(Phase::Cancelled, None, None),
        Err(Stopped::Failed(message)) => jobs::finish(Phase::Failed, Some(message), None),
    }
}

struct Outcome {
    pushed: Option<String>,
    needs_merge: bool,
}

#[derive(Debug)]
enum Stopped {
    Cancelled,
    Failed(String),
}

impl From<mirror::Failed> for Stopped {
    fn from(failed: mirror::Failed) -> Self {
        Stopped::Failed(failed.message())
    }
}

impl From<scan::Failed> for Stopped {
    fn from(failed: scan::Failed) -> Self {
        Stopped::Failed(failed.message())
    }
}

fn work(
    home: &Path,
    config: &Config,
    push: bool,
    cancel: &Arc<AtomicBool>,
) -> Result<Outcome, Stopped> {
    let dir = mirror::mirror_dir(home);
    let enabled = config.enabled_ids();

    jobs::phase(Phase::Opening);
    mirror::open(&dir, config.remote_url.as_deref())?;
    mirror::require_clean(&dir)?;
    stop_if_cancelled(cancel)?;

    jobs::phase(Phase::Fetching);
    mirror::fetch(&dir)?;
    let branch = mirror::branch(&dir);
    mirror::adopt_remote(&dir, &branch)?;
    stop_if_cancelled(cancel)?;

    jobs::phase(Phase::Reading);
    let here = scan::scan(home, &enabled)?;
    jobs::note_scan(here.notes.clone());
    let read = here.files.len() as u64;
    jobs::progress(read, Some(read), None);
    stop_if_cancelled(cancel)?;

    jobs::phase(Phase::Comparing);
    let there = mirror::read_tree(&dir, &format!("origin/{branch}"))?;
    let base = mirror::base_tree(&dir)?;
    let decided = plan::compare(&here.files, &there, &base, &jobs::settled());
    jobs::set_conflicts(decided.diverged.clone());
    stop_if_cancelled(cancel)?;

    jobs::phase(Phase::Writing);
    let outcome = apply::apply(home, &mirror::backup_dir(home), &enabled, &decided.to_machine);
    jobs::note_apply(&outcome);
    mirror::stage(&dir, &decided.to_repo)?;
    stop_if_cancelled(cancel)?;

    if !push {
        // A launch pull takes what only the other side changed and stops. It
        // sends nothing, so opening Boite never publishes on its own.
        return Ok(Outcome { pushed: None, needs_merge: !decided.settled() });
    }

    jobs::phase(Phase::Committing);
    let message = format!("{}: {} files", this_machine(), decided.to_repo.len());
    let committed = mirror::commit(&dir, &message)?;
    stop_if_cancelled(cancel)?;

    jobs::phase(Phase::Pushing);
    if committed.is_some() {
        if let Err(failed) = mirror::push(&dir, &branch) {
            let message = failed.message();
            if !mirror::reads_as_rejected(&message) {
                return Err(Stopped::Failed(message));
            }
            // Somebody pushed while this was working. One quiet retry from the
            // fetch, because losing a race is nobody's mistake; a second refusal
            // is something the user should be told about.
            mirror::fetch(&dir)?;
            mirror::adopt_remote(&dir, &branch)?;
            mirror::stage(&dir, &decided.to_repo)?;
            mirror::commit(&dir, &message)?;
            mirror::push(&dir, &branch).map_err(|second| {
                Stopped::Failed(format!(
                    "another machine pushed while this one was syncing: {}",
                    second.message()
                ))
            })?;
        }
    }

    // Only now, and only when nothing is still waiting on a person: an unmerged
    // file has to stay diverged, or the next run would read the other machine's
    // version as agreed and adopt it quietly.
    if decided.settled() {
        if let Some(sha) = mirror::head(&dir) {
            mirror::set_base(&dir, &sha)?;
        }
        // Now that they are in the repository, the next comparison finds them
        // there and needs no reminder.
        jobs::forget_settled();
    }
    Ok(Outcome { pushed: committed, needs_merge: !decided.settled() })
}

fn stop_if_cancelled(cancel: &Arc<AtomicBool>) -> Result<(), Stopped> {
    if jobs::cancelled(cancel) {
        return Err(Stopped::Cancelled);
    }
    Ok(())
}

/// The only per-machine fact the shared-tree layout keeps, and it lives in a
/// commit message rather than in the tree.
fn this_machine() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(key) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "a machine".to_string()
}

fn git_is_here() -> bool {
    static ANSWER: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ANSWER.get_or_init(|| which::which("git").is_ok())
}

/// The mirror and the backups, for a panel that wants to say where they are.
pub fn directories(home: &Path) -> (PathBuf, PathBuf) {
    (mirror::mirror_dir(home), mirror::backup_dir(home))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ten agents plus the shared tree, every one with an answer — including the
    /// seven whose answer is that nothing syncs yet.
    #[test]
    fn every_source_has_a_row_and_says_whether_it_is_supported() {
        let rows = sources_blocking(None);
        assert_eq!(rows.len(), manifest::KNOWN_CLIS.len() + 1);
        let agents = rows.iter().find(|row| row.id == manifest::AGENTS_ID).expect("agents");
        assert!(agents.supported);
        let codex = rows.iter().find(|row| row.id == "codex").expect("codex");
        assert!(!codex.supported, "codex claims a configuration this branch cannot place");
        assert!(codex.paths.is_empty());
    }

    /// Asked before any work starts, so no job row appears and no spinner turns
    /// for something that was never going to run.
    #[test]
    fn a_sync_with_no_repository_is_refused_before_it_starts() {
        let home = std::env::temp_dir().join("boite-sync-no-remote");
        let _ = std::fs::create_dir_all(&home);
        assert!(
            start_blocking(&home, &Config::default(), false).is_err(),
            "a sync started with nowhere to sync to"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The whole thing, offline: one machine publishes, another already has its
    /// own version, the difference goes to a person, and the merged file lands
    /// on both sides.
    ///
    /// `work` is called rather than `start_blocking` so the test does not race a
    /// worker thread. The slot it writes to is process-wide, hence the gate.
    #[test]
    fn two_machines_meet_over_a_file_they_both_changed() {
        let _alone = jobs::exclusive();
        if which::which("git").is_err() {
            eprintln!("skipping: git is not on this machine");
            return;
        }
        let bench = std::env::temp_dir()
            .join("boite-sync-e2e")
            .join(format!("run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bench);
        std::fs::create_dir_all(bench.join("origin")).expect("origin");
        {
            let mut cmd = crate::git::git(&bench.join("origin"));
            cmd.args(["init", "--bare", "-b", "main", "--quiet"]);
            crate::git::run(cmd).expect("bare origin");
        }
        let config = Config {
            remote_url: Some(bench.join("origin").display().to_string()),
            enabled: vec![manifest::AGENTS_ID.to_string()],
        };

        let first = bench.join("first-home");
        write_agents(&first, "# from the first\n");
        let never = Arc::new(AtomicBool::new(false));
        work(&first, &config, true, &never).expect("the first machine syncs");
        assert!(jobs::conflicts().is_empty(), "a lone first machine had a conflict");

        // A second machine that already has its own AGENTS.md, and has never
        // synced. Its base is empty, so this must not be adopted quietly.
        jobs::forget_everything();
        let second = bench.join("second-home");
        write_agents(&second, "# from the second\n");
        let outcome = work(&second, &config, true, &never).expect("the second syncs");
        assert!(outcome.needs_merge, "the second machine overwrote or was overwritten");
        assert_eq!(jobs::conflicts().len(), 1);
        assert_eq!(
            std::fs::read_to_string(second.join(".agents").join("AGENTS.md")).expect("read"),
            "# from the second\n",
            "an unmerged file was written over"
        );

        // The user keeps both sides, stacked — the thing the merge tool is for.
        let merged = "# from the first\n# from the second\n";
        let path = jobs::conflicts()[0].path.clone();
        resolve_blocking(&second, &config, &path, merged).expect("resolve");
        assert!(jobs::conflicts().is_empty());
        assert_eq!(
            std::fs::read_to_string(second.join(".agents").join("AGENTS.md")).expect("read"),
            merged
        );

        // And now it settles, pushes, and remembers where it got to.
        let outcome = work(&second, &config, true, &never).expect("the second finishes");
        assert!(!outcome.needs_merge);
        assert!(mirror::base(&mirror::mirror_dir(&second)).is_some(), "the base did not move");

        // The first machine takes it without being asked a second time.
        jobs::forget_everything();
        let outcome = work(&first, &config, true, &never).expect("the first catches up");
        assert!(!outcome.needs_merge, "{:?}", jobs::conflicts());
        assert_eq!(
            std::fs::read_to_string(first.join(".agents").join("AGENTS.md")).expect("read"),
            merged
        );

        let _ = std::fs::remove_dir_all(&bench);
    }

    fn write_agents(home: &Path, body: &str) {
        let path = home.join(".agents");
        std::fs::create_dir_all(&path).expect("dirs");
        std::fs::write(path.join("AGENTS.md"), body).expect("write");
    }

    /// Only a file the comparison put in front of the user, or this would be a
    /// write-anywhere primitive.
    #[test]
    fn a_merge_result_for_a_file_nobody_asked_about_is_refused() {
        let home = std::env::temp_dir().join("boite-sync-not-waiting");
        let _ = std::fs::create_dir_all(&home);
        let refused = resolve_blocking(&home, &Config::default(), "agents/.agents/x.md", "hello");
        assert!(refused.is_err());
        assert!(refused.unwrap_err().contains("waiting"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
