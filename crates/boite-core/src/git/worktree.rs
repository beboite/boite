//! A detached checkout per thread, and everything that keeps it honest.
//!
//! An agent gets its own worktree so two of them can work in one repository
//! without stepping on each other. The lifecycle is the interesting part: they
//! are provisioned ahead of time when that is cheap, adopted when a thread comes
//! back to one it already owns, migrated out of the layout an earlier release
//! used, and refused removal while they still hold work nobody has claimed.

use super::*;

/// Where a project keeps everything Boite puts on its disk.
pub const BOITE_DIR: &str = ".boite";

/// Where grok reads a project's MCP servers from.
///
/// Boite writes it into a thread's worktree because grok has no launch flag for
/// a server definition. Named beside `BOITE_DIR` rather than beside its writer
/// because the exclusion below is what keeps the worktree removable.
pub const GROK_DIR: &str = ".grok";

/// Where this project's thread worktrees live.
///
/// Inside the project, which reverses the earlier rule, and the reason is that
/// neither of the two mechanisms that make a worktree cheap crosses a volume: a
/// copy-on-write clone cannot, and neither can a hard link. A base beside the
/// database means anyone whose projects sit on a second drive gets no `target`
/// at all and pays a full recompile and a full copy per worktree. Measured on
/// one machine: 19 worktrees, 45.8 GB, 99% of it build output that should have
/// cost nothing. Living in the project makes the shared volume a property of
/// the layout rather than something the user has to get right.
///
/// The objection this used to carry — a nested worktree shows up as untracked
/// and leaves the main checkout permanently dirty — is answered by
/// `ensure_boite_excluded` rather than by moving out of the project.
///
/// The trust boundary gets tighter, not looser: the project is already a
/// registered root, so a worktree under it needs no root of its own.
pub fn worktree_base_for(repo: &Path) -> PathBuf {
    repo.join(BOITE_DIR).join("worktrees")
}

/// Keeps what Boite writes into a checkout out of its `git status`.
///
/// `.git/info/exclude` rather than `.gitignore`: the directories are this
/// machine's business, and a collaborator who never runs Boite should not find
/// a rule for them in a tracked file. `info/` lives in the common directory, so
/// one write covers the main checkout and every worktree linked to it.
/// Best-effort, because the cost of failing is a noisy `git status` rather than
/// anything broken.
///
/// `.grok/` is here for a harder reason than noise. An untracked file makes
/// `worktree_hold_blocking` call the worktree dirty, and a dirty worktree
/// refuses the unforced remove that closing a thread asks for, so leaving it
/// out leaks one worktree per grok thread onto the disk.
///
/// `git clean -xdf` is not a hazard here despite the directories being ignored:
/// git refuses to descend into a nested checkout and prints `Skipping
/// repository`. Only `-xdff`, which is documented as meaning exactly that,
/// removes it.
pub fn ensure_boite_excluded(repo: &Path) {
    let Some(git_dir) = git_dir(repo) else {
        return;
    };
    let exclude = git_dir.join("info").join("exclude");
    let existing = fs::read_to_string(&exclude);
    let mut text = existing.as_deref().unwrap_or_default().to_string();
    let mut added = false;
    for dir in [BOITE_DIR, GROK_DIR] {
        let rule = format!("{dir}/");
        if text.lines().any(|l| l.trim() == rule || l.trim() == dir) {
            continue;
        }
        let sep = if text.ends_with('\n') || text.is_empty() { "" } else { "\n" };
        text = format!("{text}{sep}{rule}\n");
        added = true;
    }
    if !added {
        return;
    }
    if existing.is_err() {
        let _ = fs::create_dir_all(exclude.parent().unwrap_or(&exclude));
    }
    // Not fatal — the worktrees work either way — but the user sees the result
    // as their own repository suddenly full of untracked directories, and
    // nothing connects that to this.
    if let Err(e) = fs::write(&exclude, text) {
        eprintln!(
            "[boite/worktree] {} could not be written: {e}. Worktree directories will show up as untracked.",
            exclude.display()
        );
    }
}

/// One directory named after an id, directly under `base` and never elsewhere.
///
/// Used for thread worktrees: the result is always exactly one level down, so
/// the filesystem trust boundary gains one root — the base — rather than one per
/// directory fed from a stored id.
pub fn scoped_dir_for(base: &Path, id: &str) -> PathBuf {
    // Ids are generated, but this path reaches `git worktree add` and
    // `create_dir_all`, so it is treated as untrusted input: anything that is
    // not plainly a name is replaced rather than escaped.
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    base.join(if safe.is_empty() { "unnamed".into() } else { safe })
}

/// What a worktree is still holding that removing it would destroy.
///
/// Nothing here is stored: both answers are read back off the repository, so
/// they stay true across a restart, a crash, and a worktree Boite did not make.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeHold {
    /// Modified, staged or untracked files. An agent's work in progress.
    pub dirty: bool,
    /// HEAD is on no local branch, so the commits here are reachable from
    /// nowhere else and go away with the directory. False once a branch has
    /// been claimed: removing the worktree then leaves the branch behind.
    pub orphan_commits: bool,
}

impl WorktreeHold {
    pub fn holds_work(&self) -> bool {
        self.dirty || self.orphan_commits
    }
}

fn is_oid(text: &str) -> bool {
    text.len() >= 40 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Where a repository keeps its refs and its objects.
///
/// A linked worktree has a `.git` directory of its own, holding its HEAD and its
/// index, and shares everything else with the main checkout. `commondir` is
/// where git itself records that path; join handles it whether it was written
/// relative or absolute.
fn common_dir(gitdir: &Path) -> PathBuf {
    fs::read_to_string(gitdir.join("commondir"))
        .ok()
        .map(|rel| gitdir.join(rel.trim()))
        .unwrap_or_else(|| gitdir.to_path_buf())
}

/// The object id a ref that has been packed away resolves to.
fn packed_ref(common: &Path, reference: &str) -> Option<String> {
    let packed = fs::read_to_string(common.join("packed-refs")).ok()?;
    packed
        .lines()
        .filter_map(|line| line.split_once(' '))
        .find(|(_, name)| name.trim() == reference)
        .map(|(oid, _)| oid.trim().to_string())
        .filter(|oid| is_oid(oid))
}

/// The commit HEAD is on, read off the filesystem.
///
/// `git rev-parse --verify HEAD` answers the same question and costs a process,
/// which on Windows is the expensive part of opening a worktree — measured at
/// 57ms on this developer's machine, in front of every new agent thread. Nothing
/// it looks at is computed: HEAD is either an object id or a symref into
/// `refs/`, and a ref that has been packed is a line in `packed-refs`.
fn head_oid(repo: &Path) -> Option<String> {
    let gitdir = git_dir(repo)?;
    let common = common_dir(&gitdir);
    let mut target = fs::read_to_string(gitdir.join("HEAD"))
        .ok()?
        .trim()
        .to_string();
    // A ref is allowed to name another ref, and `git symbolic-ref` writes
    // exactly that. Bounded rather than recursive: a cycle between two of them
    // is a broken repository, not a reason to read files forever.
    for _ in 0..8 {
        let Some(reference) = target.strip_prefix("ref:") else {
            // Detached, or the end of the chain: an object id.
            return is_oid(&target).then_some(target);
        };
        let reference = reference.trim().to_string();
        match fs::read_to_string(common.join(&reference)) {
            Ok(loose) => target = loose.trim().to_string(),
            // `packed-refs` holds no symrefs, so a packed answer ends the chain
            // whichever way it comes back.
            Err(_) => return packed_ref(&common, &reference),
        }
    }
    None
}

/// Whether HEAD names a commit that exists. False for an unborn branch, which
/// is a repository nothing can be checked out from yet, false for a ref left
/// pointing at an object that is gone, and false for a ref that resolves to
/// something that is not a commit: a tag object or a tree, neither of which
/// `worktree add --detach` can open a checkout on.
///
/// A ref outlives what it points at whenever history is rewritten or a fetch is
/// cut short, and reading the ref file cannot see that. `cat-file -e` can, over
/// every shape the object database comes in, packed or loose and whichever hash
/// the repository was created with. The `^{commit}` peel is what turns object
/// existence into the stricter question actually being asked. It costs a
/// process, and the only caller spawns `git worktree add` right after, which is
/// orders of magnitude more expensive than this check.
fn head_has_commit(repo: &Path) -> bool {
    let Some(oid) = head_oid(repo) else {
        return false;
    };
    let mut cmd = git(repo);
    cmd.args(["cat-file", "-e", &format!("{oid}^{{commit}}")]);
    run(cmd).is_ok()
}

/// Opens a worktree on the repository's current HEAD, detached.
///
/// Detached on purpose: a named branch would have to be invented before anyone
/// knows what the work is, it would sit in the branch list whether or not the
/// work was worth keeping, and Git refuses to check the same branch out twice —
/// which would make two threads on `master` an error instead of the default.
pub fn add_detached_worktree_blocking(repo: &str, path: &str) -> Result<String, String> {
    let r = Path::new(repo);
    if !r.is_dir() {
        return Err("Not a directory".into());
    }
    // `worktree add` on a repository with no commits fails with a message about
    // an invalid reference, which reads as a bug rather than as "commit first".
    if !head_has_commit(r) {
        return Err("This repository has no commits yet.".into());
    }
    if Path::new(path).exists() {
        return Err(format!("'{path}' already exists."));
    }
    // Before the checkout rather than after: the worktree lands inside the
    // project, and a `git status` run in between would report it as untracked.
    ensure_boite_excluded(r);
    let mut cmd = git(r);
    cmd.args(["worktree", "add", "--detach", path]);
    run(cmd)?;
    // Taken from the main checkout, not rebuilt. Without this a worktree costs
    // a full install and a full recompile before anything can run in it, which
    // is the difference between an isolated thread and an unusable one.
    provision_shared_artifacts(r, Path::new(path));
    Ok(path.to_string())
}

/// Suffix of the file that marks a worktree as unclaimed.
///
/// Beside the directory, never inside it. A marker file in the worktree would be
/// an untracked file, which is exactly what `worktree_hold_blocking` reads as
/// "there is work in here" and what the Worktrees tab paints as a dirty row.
const SPARE_SUFFIX: &str = ".spare";

/// What every directory the pool makes is called, and nothing else is.
///
/// A claimed spare is renamed after the thread that took it, so this prefix
/// means "the pool made this and still answers for it" — which is what lets the
/// sweep tell a leaked directory from a thread's checkout.
const SPARE_PREFIX: &str = "spare-";

/// How many unclaimed worktrees the pool keeps for one project.
///
/// A spare is a whole checkout plus the build artifacts, and it is made on the
/// cheapest gesture in the app. Uncapped, a browse through twenty projects wrote
/// twenty checkouts and nothing ever took one back. The most recent few are
/// where the next thread is going.
///
/// This used to count every repository together, because every base was the same
/// directory. Each project now has its own, so the same number is a ceiling per
/// project instead of one for the machine. Warming stops at `READY_SPARES`, so
/// the rest of the allowance is for a `HEAD` that keeps moving.
const MAX_SPARES: usize = 5;

/// How many spares a project keeps standing by once it is at rest.
///
/// One was enough for a single thread and nothing more: launching two agents in
/// a row emptied the pool on the first, and the second paid the whole checkout
/// in front of its terminal while the refill was still running.
///
/// Two was not enough either, and this is the number the whole feature turns on.
/// Measured here: a burst of four launches takes two spares in 120ms each and
/// leaves the other two paying 26s and 35s in front of a black terminal, since
/// the refill is still linking while they ask. Provisioning is around 42 000
/// hard links on this repository and nothing makes that cheap — the only thing
/// that takes it off a launch is having the directory ready before the click.
/// A spare costs a checkout on disk and hard links that cost almost nothing, so
/// depth is the cheap side of this trade. It stays under `MAX_SPARES` so a
/// moving `HEAD` still has room above it.
const READY_SPARES: usize = 3;

/// How long an unclaimed spare is worth keeping.
///
/// Its copy of `node_modules` and `.venv` was taken when it was made, so an old
/// one would hand an agent the dependencies of an old lockfile — and in the
/// meantime it is disk nobody asked for. Markers survive a restart, so without
/// this the oldest spare of a project has no upper age at all.
const SPARE_MAX_AGE: Duration = Duration::from_secs(12 * 60 * 60);

/// Where a worktree's marker goes, or none for a path with no final component.
///
/// Refused rather than defaulted: `file_name` answers none for a filesystem
/// root and for a path ending in `..`, and a default would name every one of
/// them the same bare `.spare` beside a directory nobody meant.
fn spare_marker(dir: &Path) -> Option<PathBuf> {
    let mut name = dir.file_name()?.to_os_string();
    name.push(SPARE_SUFFIX);
    Some(dir.with_file_name(name))
}

/// Whether this worktree is one nobody has taken yet. Read by the listing, so an
/// unclaimed spare is not shown as a worktree the user has something to do with.
pub fn is_spare_worktree(dir: &str) -> bool {
    spare_marker(Path::new(dir)).is_some_and(|marker| marker.is_file())
}

/// What a claimed directory that kept its pool name is marked with.
const CLAIM_SUFFIX: &str = ".claimed";

/// Where a claim marker goes, on the same terms as `spare_marker`.
fn claim_marker(dir: &Path) -> Option<PathBuf> {
    let mut name = dir.file_name()?.to_os_string();
    name.push(CLAIM_SUFFIX);
    Some(dir.with_file_name(name))
}

/// Says a thread owns this directory even though it is still called `spare-`.
///
/// Renaming a claimed spare is allowed to fail, and the name is cosmetic next to
/// handing the thread a checkout that works. What is not cosmetic is that the
/// orphan sweep reads the name: a directory the rename left behind has a pool
/// name and no pool marker, which is exactly the shape the sweep collects, so
/// twelve hours later it removed a live thread's checkout out from under it.
/// This is the flag that tells the two apart.
fn mark_claimed(dir: &Path) {
    if let Some(marker) = claim_marker(dir) {
        let _ = fs::write(marker, "claimed\n");
    }
}

/// Whether a thread was handed this directory and it never got renamed.
fn is_claimed(dir: &Path) -> bool {
    claim_marker(dir).is_some_and(|marker| marker.is_file())
}

/// Takes the flag off, for a directory that is being removed or renamed.
fn drop_claim_marker(dir: &Path) {
    if let Some(marker) = claim_marker(dir) {
        let _ = fs::remove_file(marker);
    }
}

/// Takes a spare out of the pool, which is what claiming one for a thread and
/// reworking one both have to do before they touch the directory.
///
/// Deleting the marker *is* the claim, and it is a single filesystem operation,
/// so whichever caller the kernel serves first owns the directory and every
/// other one is told plainly that it does not. That is what keeps
/// `git checkout --detach` out of a worktree an agent has already been handed:
/// warming does not get to touch a directory whose marker it did not take.
fn take_marker(dir: &Path) -> bool {
    spare_marker(dir).is_some_and(|marker| fs::remove_file(marker).is_ok())
}

/// Same directory, whatever the platform spelled it as.
///
/// Text first: both paths were usually written by this app. Git's porcelain
/// list is the exception. It prints the canonical form, so `/var` becomes
/// `/private/var` on macOS and Windows may 8.3-shorten a name. Canonicalize
/// only when the strings disagree, and only then.
fn same_dir(a: &Path, b: &Path) -> bool {
    if norm_dir(a) == norm_dir(b) {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => norm_dir(&ca) == norm_dir(&cb),
        _ => false,
    }
}

/// One spelling of a directory, for the comparisons here that are text.
///
/// Separators and a trailing slash are normalized everywhere. Windows paths
/// can also name the same directory with different case.
fn norm_dir(p: &Path) -> String {
    let text = p.to_string_lossy().replace('\\', "/");
    let text = text.trim_end_matches('/');
    #[cfg(windows)]
    {
        text.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text.to_owned()
    }
}

struct Spare {
    dir: PathBuf,
    /// The repository this checkout came from, as its marker recorded it.
    repo: PathBuf,
    /// The commit the checkout in there is on.
    head: String,
    /// When it was made, in seconds since the epoch. Zero for a marker written
    /// before this line existed, which reads as ancient and gets collected.
    at: u64,
}

/// The unclaimed worktrees under `base`, all of them or only one repository's.
///
/// Read off the disk rather than held in memory, so a spare survives a restart
/// instead of being leaked and remade. Cheap: one directory listing and a couple
/// of small file reads.
fn read_spares(base: &Path, repo: Option<&Path>) -> Vec<Spare> {
    let Ok(entries) = fs::read_dir(base) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let marker = entry.path();
        let Some(name) = marker.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(dir_name) = name.strip_suffix(SPARE_SUFFIX) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(&marker) else {
            continue;
        };
        let mut owner: Option<&str> = None;
        let mut head: Option<&str> = None;
        let mut at = 0u64;
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("repo=") {
                owner = Some(v.trim());
            } else if let Some(v) = line.strip_prefix("head=") {
                head = Some(v.trim());
            } else if let Some(v) = line.strip_prefix("at=") {
                at = v.trim().parse().unwrap_or(0);
            }
        }
        let (Some(owner), Some(head)) = (owner, head) else {
            continue;
        };
        if repo.is_some_and(|repo| !same_dir(Path::new(owner), repo)) {
            continue;
        }
        out.push(Spare {
            dir: base.join(dir_name),
            repo: PathBuf::from(owner),
            head: head.to_string(),
            at,
        });
    }
    out
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_spare_marker(dir: &Path, repo: &Path, head: &str) -> std::io::Result<()> {
    let marker = spare_marker(dir)
        .ok_or_else(|| std::io::Error::other("a worktree path with no name"))?;
    fs::write(
        marker,
        format!(
            "repo={}\nhead={}\nat={}\n",
            repo.display(),
            head,
            now_secs()
        ),
    )
}

/// How long an administrative entry must have been pointing at nothing before
/// pruning is allowed to take it.
///
/// Any delay at all would do; the window this closes is milliseconds wide. An
/// hour is chosen for having no downside: every directory this app registers is
/// named after a thread id, so a path is never reused and nothing waits on the
/// entry going away.
const PRUNE_GRACE: &str = "1.hour.ago";

/// Drops administrative entries whose directory is gone, and only those that
/// have been that way for a while.
///
/// The delay is the whole point. A bare `git worktree prune` takes every entry
/// whose directory it cannot find *right now*, and this repository moves
/// directories out from under exactly such an entry twice: `rename_claimed`
/// renames a spare to its thread's name before `git worktree repair` tells git
/// where it went, and the migration does the same across volumes. Both windows
/// are one filesystem call wide, and closing several threads runs one prune per
/// close — so closing a handful while opening one would delete the new
/// thread's entry mid-rename. `repair` cannot undo that: the entry holds the
/// worktree's HEAD and index, and once it is gone git answers `fatal: not a git
/// repository` for a directory that is still full of the agent's work. Ten of
/// them were made that way on one machine before this was understood.
fn prune_stale_worktrees(repo: &Path) {
    let mut prune = git(repo);
    prune.args(["worktree", "prune", "--expire", PRUNE_GRACE]);
    let _ = run(prune);
}

/// Gives a spare's directory back. Never a worktree anyone is using.
///
/// Unforced: the pool only ever owns directories nobody has been handed, so a
/// refusal here means there is real work in one — somebody opened a shell in a
/// spare and wrote in it — and it is left alone. Its marker is gone by the time
/// this runs, so it shows up in the Worktrees tab as the ordinary worktree it
/// has become, which is the one place it can still be dealt with.
fn drop_spare(repo: &Path, dir: &Path) {
    let _ = remove_worktree_blocking(&repo.to_string_lossy(), &dir.to_string_lossy(), false);
}

/// Keeps the pool inside its bounds, by count and by age.
///
/// Called from warming rather than from a timer, because warming is the only
/// thing that ever makes the pool bigger, and therefore the only moment it can
/// be over.
fn collect_spares(base: &Path, repo: &Path) {
    sweep_orphan_spares(base, repo, now_secs());
    let mut spares = read_spares(base, None);
    // Newest first, so what survives the cap is what the next thread is most
    // likely to want.
    spares.sort_by_key(|spare| std::cmp::Reverse(spare.at));
    let now = now_secs();
    let mut kept = 0usize;
    for spare in spares {
        let expired = now.saturating_sub(spare.at) > SPARE_MAX_AGE.as_secs();
        if !expired && kept < MAX_SPARES {
            kept += 1;
            continue;
        }
        // Taken out of the pool exactly as a thread takes one: a spare claimed
        // between the listing above and this line is not ours to remove.
        if !take_marker(&spare.dir) {
            continue;
        }
        if spare.dir.is_dir() {
            drop_spare(&spare.repo, &spare.dir);
        }
    }
}

/// Removes pool directories nobody can account for any more.
///
/// A spare is claimed by deleting its marker, so between that deletion and the
/// rename that gives it a thread's name there is a directory with a pool name
/// and no marker. Interrupt the app in that window — or fail the marker write
/// that puts a reworked spare back — and the directory stays registered as a
/// worktree with no owner: the pool cannot see it, the cap does not count it,
/// and nothing ever removes it.
///
/// Age is what makes this safe. The window above is measured in milliseconds,
/// so anything still nameless a whole `SPARE_MAX_AGE` later was left behind
/// rather than being handed over, and the removal refuses on real work anyway.
///
/// `now` is passed rather than read so a test can say "a day later" without
/// rewriting timestamps on a directory, which no two platforms spell the same.
fn sweep_orphan_spares(base: &Path, repo: &Path, now: u64) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(SPARE_PREFIX) {
            continue;
        }
        // Still in the pool, so the loop below owns it.
        if spare_marker(&dir).is_some_and(|marker| marker.is_file()) {
            continue;
        }
        // Handed to a thread, and only the rename that would have taken the pool
        // name off it failed. Age says nothing about this one: a thread can sit
        // in a checkout for days.
        if is_claimed(&dir) {
            continue;
        }
        let age = fs::metadata(&dir)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| now.saturating_sub(d.as_secs()))
            .unwrap_or(0);
        if age <= SPARE_MAX_AGE.as_secs() {
            continue;
        }
        drop_spare(repo, &dir);
    }
}

/// Gives a claimed spare the name of the thread that took it.
///
/// Without this a thread's checkout keeps the name the pool gave it, so
/// `spare-...` on disk means either "standing by" or "handed out" and nothing
/// tells them apart: the sweep above cannot collect what it cannot recognise,
/// and the Worktrees tab named a thread's directory after the pool.
///
/// Same base, so this is a rename and not a copy, and `git worktree repair` is
/// what makes git follow it. Every failure keeps the directory where it is: the
/// name is cosmetic next to handing the thread a checkout that works.
fn rename_claimed(repo: &Path, from: &Path, label: &str) -> Option<String> {
    let base = from.parent()?;
    let to = scoped_dir_for(base, label);
    if to.exists() {
        return None;
    }
    fs::rename(from, &to).ok()?;
    let mut repair = git(repo);
    repair.args(["worktree", "repair", &to.to_string_lossy()]);
    if run(repair).is_err() {
        // Back where git still believes it is, rather than left at a path git
        // was never told about. If even that fails the checkout is at a path
        // nothing knows, which is the one outcome here that a person has to
        // sort out by hand, so it says where it left it.
        if let Err(e) = fs::rename(&to, from) {
            eprintln!(
                "[boite/worktree] {} was moved to {} and could not be put back: {e}. \
                 git still expects it at the first path; `git worktree repair` there fixes it.",
                from.display(),
                to.display()
            );
        }
        return None;
    }
    Some(to.to_string_lossy().into_owned())
}

/// Moves an existing checkout onto another commit. One process, and it writes
/// only the paths that differ between the two trees.
fn detach_to(worktree: &Path, oid: &str) -> Result<(), String> {
    let mut cmd = git(worktree);
    cmd.args(["checkout", "--detach", oid]);
    run(cmd).map(|_| ())
}

/// Claims a ready-made worktree for this repository, or answers that there is
/// none to claim.
///
/// Spares on the commit the project is on are offered first, whatever order the
/// pool came back in. One that is behind still costs a `git checkout --detach`
/// over the diff, and paying that while a ready one sits in the same pool is
/// exactly what a thread is waiting through.
fn take_spare(base: &Path, repo: &Path) -> Option<String> {
    let wanted = head_oid(repo)?;
    let now = now_secs();
    let (ready, behind): (Vec<_>, Vec<_>) = read_spares(base, Some(repo))
        .into_iter()
        .partition(|spare| spare.head == wanted);
    for spare in ready.into_iter().chain(behind) {
        // Of two threads born at the same moment exactly one wins a given spare,
        // and the other moves on to the next.
        if !take_marker(&spare.dir) {
            continue;
        }
        // A marker that outlived its directory: deleted by hand, or a creation
        // that failed after writing it. The claim above is what cleaned it up.
        if !spare.dir.is_dir() {
            continue;
        }
        // Older than its copy of the shared directories is worth trusting.
        // Handing it over would give the agent whatever lockfile was current
        // when it was made.
        if now.saturating_sub(spare.at) > SPARE_MAX_AGE.as_secs() {
            drop_spare(repo, &spare.dir);
            continue;
        }
        if spare.head == wanted {
            return Some(spare.dir.to_string_lossy().into_owned());
        }
        // Made before the last commits landed. A thread has to start on the
        // commit the project is on, and moving this checkout is one process over
        // the diff, where making another is a whole checkout plus its shared
        // directories again.
        if detach_to(&spare.dir, &wanted).is_ok() {
            // The checkout it just did can have taken one of them away, and a
            // spare made before an install has never seen the rest. Cheap when
            // there is nothing to do: one stat per directory.
            provision_shared_artifacts(repo, &spare.dir);
            return Some(spare.dir.to_string_lossy().into_owned());
        }
        // Refused to move — something is in there after all. Never hand back a
        // checkout of the wrong commit. Removed here and not on a thread of its
        // own: the caller goes straight on to `worktree add` in this same
        // repository, and two git processes in `.git/worktrees` at once is a
        // race for no gain.
        drop_spare(repo, &spare.dir);
    }
    None
}

/// Repositories a spare is being made for right now. Two warms would otherwise
/// each find none and each make one.
static WARMING: parking_lot::Mutex<Vec<String>> = parking_lot::Mutex::new(Vec::new());

struct WarmGuard(String);

impl WarmGuard {
    /// None when another thread is already warming this repository.
    fn claim(repo: &Path) -> Option<Self> {
        let key = repo.to_string_lossy().to_lowercase();
        let mut warming = WARMING.lock();
        if warming.contains(&key) {
            return None;
        }
        warming.push(key.clone());
        Some(Self(key))
    }
}

impl Drop for WarmGuard {
    fn drop(&mut self) {
        WARMING.lock().retain(|k| k != &self.0);
    }
}

/// Makes sure this repository has `READY_SPARES` worktrees standing by, and that
/// each one is on the commit the repository is on.
///
/// This is the whole point of the pool: `git worktree add` plus the shared
/// directories is around half a second on a small repository and seconds on a
/// large one, and it used to sit between a click and a terminal that could show
/// anything. Paid here instead, off any click.
///
/// Never asks whether the main checkout is clean. That question decides whether
/// a *thread* gets a worktree; a spare is made from HEAD either way, and one
/// made while the checkout was dirty is exactly as good once it is clean again.
pub fn warm_worktree_pool_blocking(repo: &str, base: &str) -> Result<(), String> {
    let r = Path::new(repo);
    if git_dir(r).is_none() {
        return Ok(());
    }
    let Some(head) = head_oid(r) else {
        // No commits yet: nothing to check out, and nothing to warm.
        return Ok(());
    };
    let base = Path::new(base);
    fs::create_dir_all(base).map_err(|e| format!("worktree base: {e}"))?;
    let Some(_guard) = WarmGuard::claim(r) else {
        return Ok(());
    };

    // Before anything else, because warming is what fills the pool and this is
    // the only thing that empties it.
    collect_spares(base, r);

    let mut ready = 0usize;
    for spare in read_spares(base, Some(r)) {
        if ready >= READY_SPARES {
            // The pool is full and `collect_spares` above already trimmed it,
            // so there is nothing left for this call to do.
            return Ok(());
        }
        if !spare.dir.is_dir() {
            // A marker that outlived its directory.
            let _ = take_marker(&spare.dir);
            continue;
        }
        // Already standing by, on the commit the project is on.
        if spare.head == head {
            ready += 1;
            continue;
        }
        // Behind the project. Brought up to date here rather than at claim time,
        // so the thread that takes it pays nothing at all — but only after
        // taking the marker, which is the same single operation a thread's claim
        // uses. Losing that race means an agent now owns this directory and is
        // already writing in it, and `git checkout --detach` in there would
        // throw that work away.
        if !take_marker(&spare.dir) {
            continue;
        }
        if detach_to(&spare.dir, &head).is_ok() {
            provision_shared_artifacts(r, &spare.dir);
            // Back in the pool, and not one moment earlier: between the two
            // lines above it belongs to this call and to nobody else.
            let _ = write_spare_marker(&spare.dir, r, &head);
            ready += 1;
            continue;
        }
        // It would not move, so it is not something to hand a thread.
        drop_spare(r, &spare.dir);
    }

    // Whatever the pool is still short of. One `git worktree add` each, in this
    // call rather than one per warm: a project seen for the first time would
    // otherwise stand by with one spare until something claimed it, which is the
    // launch this exists to be ahead of.
    while ready < READY_SPARES {
        let dir = scoped_dir_for(base, &format!("{SPARE_PREFIX}{}", uuid::Uuid::new_v4()));
        add_detached_worktree_blocking(repo, &dir.to_string_lossy())?;
        // Last, so a spare is only ever offered once it is a complete checkout:
        // the marker is what makes it claimable, and a failed creation leaves a
        // directory nobody will hand out.
        write_spare_marker(&dir, r, &head).map_err(|e| format!("spare marker: {e}"))?;
        ready += 1;
    }
    // The ones just made are the newest, so this drops the oldest over the cap
    // rather than what was just paid for.
    collect_spares(base, r);
    Ok(())
}

/// How many of the changed files are worth naming to the user. Enough to
/// recognise the work, short enough to read in a toast that expires.
const DIRTY_SAMPLE: usize = 3;

/// How much of `git status` is read before the rest is taken on trust. A
/// repository with more changes than this fills the sample and sets `more`,
/// which is all the difference the caller can say anything about.
const DIRTY_READ: usize = 8 * 1024;

/// What the main checkout is holding, as far as a thread starting here cares.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MainCheckoutWork {
    /// A few of the changed paths, for the message that explains the refusal.
    pub files: Vec<String>,
    /// There are more than the sample names.
    pub more: bool,
}

impl MainCheckoutWork {
    fn clean(&self) -> bool {
        self.files.is_empty()
    }
}

/// The tracked changes in the main checkout, capped at a readable sample.
///
/// Untracked files are deliberately not among them. A tool that drops a
/// directory nobody ever ignored — a playwright artifact folder, a wrangler
/// state directory, a build cache — is not work in flight, and letting one
/// stand between every thread of that project and its worktree turned the
/// feature off silently, for weeks, with the reason only in a log file. A
/// modified or staged file is the opposite: it is what "look at what I just
/// changed" means, and a thread that cannot see it is answering the wrong
/// question.
///
/// Read into a bounded buffer rather than collected: `git status` on a large
/// repository writes more than anyone will read, and the answer here is a
/// handful of names plus whether there were others.
fn tracked_changes(repo: &Path) -> Result<MainCheckoutWork, String> {
    let mut cmd = git(repo);
    cmd.args(["status", "--porcelain", "--untracked-files=no"]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("git not found or failed to start: {e}"))?;
    let mut out = child
        .stdout
        .take()
        .ok_or_else(|| "git status: no output".to_string())?;

    let mut buf = Vec::with_capacity(DIRTY_READ);
    let mut chunk = [0u8; 1024];
    let mut truncated = false;
    loop {
        match out.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() >= DIRTY_READ {
                    truncated = true;
                    break;
                }
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git status: {e}"));
            }
        }
    }
    if truncated {
        // git cannot exit while a pipe nobody is draining is still filling up,
        // and the rest of the listing has nothing left to say.
        let _ = child.kill();
        let _ = child.wait();
    } else {
        // Only meaningful when the process was allowed to finish its sentence.
        let status = child
            .wait()
            .map_err(|e| format!("git status: {e}"))?;
        if !status.success() {
            return Err(format!("git exited with status {status}"));
        }
    }

    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    // The read stopped mid-sentence, so the last name is a fragment.
    if truncated {
        lines.pop();
    }
    let files: Vec<String> = lines
        .iter()
        .filter_map(|line| porcelain_path(line))
        .take(DIRTY_SAMPLE)
        .collect();
    Ok(MainCheckoutWork {
        more: truncated || lines.len() > files.len(),
        files,
    })
}

/// The path out of one `git status --porcelain` line.
///
/// The format is two status letters, a space, then the path; a rename writes
/// `old -> new`, and the new name is the one that exists on disk to go look at.
fn porcelain_path(line: &str) -> Option<String> {
    let path = line.get(3..)?.trim();
    if path.is_empty() {
        return None;
    }
    let named = path.rsplit(" -> ").next().unwrap_or(path);
    Some(named.trim_matches('"').to_string())
}

fn warm_in_background(repo: &Path, base: &Path) {
    let repo = repo.to_string_lossy().into_owned();
    let base = base.to_string_lossy().into_owned();
    thread::spawn(move || {
        let _ = warm_worktree_pool_blocking(&repo, &base);
    });
}

/// What became of a thread's request for a worktree.
///
/// The refusal carries its reason because nothing downstream can work it out:
/// the frontend sees a thread in the project folder and cannot tell a project
/// that turned worktrees off from a checkout that was holding work. Only one
/// refusal has anything to say — a dirty main checkout — and it is the one the
/// user can act on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeOpening {
    /// Where the thread runs. `None` is the project folder.
    pub path: Option<String>,
    /// A few of the tracked changes that kept the thread in the main checkout.
    /// Empty when the answer had nothing to do with them.
    pub dirty: Vec<String>,
    /// More files are changed than `dirty` names.
    pub more: bool,
}

impl WorktreeOpening {
    fn at(path: String) -> Self {
        Self {
            path: Some(path),
            ..Self::default()
        }
    }

    /// No worktree, and no reason worth putting in front of anyone: this
    /// directory is not a repository, which is a property of the project rather
    /// than something the user just did.
    fn nowhere() -> Self {
        Self::default()
    }
}

/// Opens a worktree for a thread, or answers that this repository is not one
/// to open a worktree in. A `None` path means the thread runs in the project
/// folder.
///
/// The eligibility checks live here rather than in the caller because each one
/// used to cost an IPC round trip and a `git` process of its own: the frontend
/// asked "is this a repo", then "is it clean", then "open one", paying three
/// process spawns to reach a decision that is mostly filesystem state. On
/// Windows a process spawn is the expensive part of this whole operation, not
/// the checkout.
///
/// `label` names the directory only when one has to be made here. The ordinary
/// path hands over a spare, which was named when it was made — that is what
/// takes `git worktree add` out from in front of the terminal, and it leaves the
/// status check below as the only thing a new thread waits on.
pub fn open_worktree_if_eligible_blocking(
    repo: &str,
    base: &str,
    label: &str,
) -> Result<WorktreeOpening, String> {
    let r = Path::new(repo);
    // No subprocess: a repository is a `.git` directory, or the `gitdir:` file
    // a worktree and a submodule get, and both are one stat away.
    if git_dir(r).is_none() {
        return Ok(WorktreeOpening::nowhere());
    }
    // "Look at what I just changed" cannot be answered from a clean worktree.
    // A main checkout holding tracked changes means the work under discussion
    // is there, so the thread starts there too — and says so, because a thread
    // that quietly lost its isolation is a thread nobody knows to fix.
    let work = tracked_changes(r)?;
    if !work.clean() {
        return Ok(WorktreeOpening {
            path: None,
            dirty: work.files,
            more: work.more,
        });
    }
    let base = Path::new(base);
    fs::create_dir_all(base).map_err(|e| format!("worktree base: {e}"))?;

    if let Some(dir) = take_spare(base, r) {
        // Named after the thread from here on: a directory still called
        // `spare-...` is one the pool is answering for, and that is what the
        // orphan sweep reads.
        let claimed = match rename_claimed(r, Path::new(&dir), label) {
            Some(renamed) => renamed,
            None => {
                // The directory keeps a pool name it no longer answers to, and
                // its pool marker is already gone. Without this the orphan sweep
                // reads it as leaked and removes it while the thread is in it.
                mark_claimed(Path::new(&dir));
                dir
            }
        };
        // Refill, so the next thread in this project is as cheap as this one.
        warm_in_background(r, base);
        return Ok(WorktreeOpening::at(claimed));
    }
    // Nothing standing by: this thread pays for its own checkout, which is what
    // every thread used to do.
    let path = scoped_dir_for(base, label).to_string_lossy().into_owned();
    let made = add_detached_worktree_blocking(repo, &path)?;
    warm_in_background(r, base);
    Ok(WorktreeOpening::at(made))
}

/// Turns a detached worktree into a branch, once its work has proved worth
/// keeping. Fails if the name is taken, so a claim never quietly hijacks an
/// existing branch.
pub fn claim_worktree_branch_blocking(worktree: &str, name: &str) -> Result<(), String> {
    let w = Path::new(worktree);
    if !w.is_dir() {
        return Err("Not a directory".into());
    }
    validate_branch_name(w, name)?;
    if local_branch_exists(w, name) {
        return Err(format!("A branch named '{name}' already exists."));
    }
    let mut cmd = git(w);
    cmd.args(["switch", "-c", name]);
    run(cmd)?;
    Ok(())
}

/// Moves a detached worktree onto a branch that already exists.
///
/// The other half of claiming: continuing something already started, rather
/// than naming something new. Git refuses a branch that is checked out in
/// another worktree — including the main one — and that refusal is worth
/// passing on plainly, because it is the whole reason a second checkout of the
/// same branch cannot exist.
pub fn reserve_worktree_branch_blocking(worktree: &str, name: &str) -> Result<(), String> {
    let w = Path::new(worktree);
    if !w.is_dir() {
        return Err("Not a directory".into());
    }
    validate_branch_name(w, name)?;
    if !local_branch_exists(w, name) {
        return Err(format!("There is no local branch named '{name}'."));
    }
    if let Some(holder) = worktree_holding_branch(w, name) {
        return Err(format!(
            "'{name}' is already checked out at {holder}. Only one worktree can hold a branch."
        ));
    }
    let mut cmd = git(w);
    cmd.args(["switch", name]);
    run(cmd)?;
    Ok(())
}

/// Which worktree, if any, currently has this branch checked out.
fn worktree_holding_branch(path: &Path, name: &str) -> Option<String> {
    let mut cmd = git(path);
    cmd.args(["worktree", "list", "--porcelain"]);
    let out = run(cmd).ok()?;
    let text = String::from_utf8_lossy(&out);
    let target = format!("refs/heads/{name}");
    let mut current: Option<String> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            current = Some(rest.to_string());
        } else if line.strip_prefix("branch ") == Some(target.as_str()) {
            return current;
        }
    }
    None
}

/// What removing this worktree would cost. Read before every removal.
pub fn worktree_hold_blocking(worktree: &str) -> Result<WorktreeHold, String> {
    let w = Path::new(worktree);
    if !w.is_dir() {
        return Err("Not a directory".into());
    }

    let mut status = git(w);
    // Untracked files count: a file the agent created and never staged is
    // exactly the work a cleanup must not throw away.
    status.args(["status", "--porcelain", "--untracked-files=normal"]);
    let dirty = !run(status)?.is_empty();

    // No local branch contains HEAD, so these commits live in this directory
    // and nowhere else. A claimed branch shows up here and clears the flag.
    //
    // `for-each-ref` rather than `branch --contains`: the latter also prints
    // the detached head itself as `* (HEAD detached at abc1234)`, so its output
    // is never empty in exactly the case this has to detect.
    let mut contains = git(w);
    contains.args(["for-each-ref", "--contains", "HEAD", "refs/heads/"]);
    let orphan_commits = run(contains)
        .map(|out| String::from_utf8_lossy(&out).trim().is_empty())
        .unwrap_or(true);

    Ok(WorktreeHold {
        dirty,
        orphan_commits,
    })
}

/// Removes a worktree, refusing while it still holds work.
///
/// `force` is the user answering for themselves after being told what is in
/// there. Automatic cleanup never passes it: it deletes empty worktrees only,
/// which is what makes an agent that forgets to claim a branch harmless.
pub fn remove_worktree_blocking(
    repo: &str,
    worktree: &str,
    force: bool,
) -> Result<(), String> {
    let r = Path::new(repo);
    if !r.is_dir() {
        return Err("Not a directory".into());
    }
    if !force {
        let hold = worktree_hold_blocking(worktree)?;
        if hold.holds_work() {
            return Err(match (hold.dirty, hold.orphan_commits) {
                (true, true) => "This worktree has uncommitted changes and commits on no branch.",
                (true, false) => "This worktree has uncommitted changes.",
                _ => "This worktree has commits that are on no branch.",
            }
            .into());
        }
    }
    // Before git touches the directory, and not optional: git deletes the tree
    // and on Windows follows a junction into the main checkout's own
    // `node_modules`, emptying it.
    unlink_shared_artifacts(r, Path::new(worktree));
    let mut cmd = git(r);
    cmd.args(["worktree", "remove", "--force", worktree]);
    run(cmd)?;
    // A worktree whose directory was deleted by hand leaves an administrative
    // file behind, and the path stays "already registered" until it is pruned.
    prune_stale_worktrees(r);
    drop_claim_marker(Path::new(worktree));
    Ok(())
}

/// Whether `dir` is a live worktree of `repo`.
///
/// A worktree's `.git` is a file pointing at `<repo>/.git/worktrees/<name>`,
/// so its grandparent is the repository's own git directory. A directory that
/// does not say that belongs to something else, and handing it over would
/// start an agent inside it.
///
/// Ours, and git no longer knows it: the administrative entry holds the
/// worktree's HEAD and index, so without it every git command run in there
/// answers `fatal: not a git repository`. That is not a checkout to start a
/// thread in.
fn owned_worktree_dir(repo: &Path, dir: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let owner = git_dir(dir)?;
    // `.git/worktrees/<name>`, not `.git/modules/<name>`: a submodule's git
    // dir has the same grandparent and is not a checkout to hand a thread.
    let worktrees_dir = owner.parent()?;
    if worktrees_dir.file_name() != Some(std::ffi::OsStr::new("worktrees")) {
        return None;
    }
    let common = worktrees_dir.parent()?;
    let mine = git_dir(repo)?;
    // `same_dir` compares text first, then asks the filesystem: one path is
    // built by joining and the other is read out of a `.git` file that git may
    // have written relative to the worktree. Asking the filesystem is what
    // settles a `..` in the middle.
    if !same_dir(common, &mine) {
        return None;
    }
    if !owner.is_dir() {
        return None;
    }
    Some(dir.to_path_buf())
}

/// Gives a thread back the worktree it lost the path to.
///
/// The database row is the only record of which directory a thread runs in, and
/// one startup that answered "gone" for a directory it could not read at that
/// moment clears it for good. The checkout stays on disk; the thread starts in
/// the project folder instead; and `--resume` then looks for its transcript
/// under a path the agent never ran in, which is what "No conversation found
/// with session ID" means while the session file is plainly there. It also puts
/// an agent to work in the user's own checkout without ever saying so.
///
/// Nothing is created, moved or repaired here. The directory is handed back only
/// when it is already this repository's worktree, which is what `git worktree
/// list` would say and is read here from the one file that says it, rather than
/// from a process: this runs once per thread at boot, and a repository with
/// twenty threads would otherwise pay twenty spawns before the first pane.
pub fn adopt_worktree_blocking(repo: &str, thread_id: &str) -> Option<String> {
    let r = Path::new(repo);
    let dir = scoped_dir_for(&worktree_base_for(r), thread_id);
    owned_worktree_dir(r, &dir).map(|p| p.to_string_lossy().into_owned())
}

/// Where git keeps the administrative entry of `dir`, when `dir` is a linked
/// worktree of `repo`.
///
/// A worktree's `.git` is a file pointing at `<repo>/.git/worktrees/<name>`, so
/// its grandparent is the repository's own git directory. Nothing else on disk
/// says who a checkout belongs to, and every caller here is about to start an
/// agent in that directory or move what is inside it.
///
/// `same_dir` settles the comparison rather than string equality: one path is
/// built by joining and the other is read out of a `.git` file git may have
/// written relative to the worktree, and a `..` in the middle only goes away by
/// asking the filesystem.
fn worktree_owner_of(repo: &Path, dir: &Path) -> Option<PathBuf> {
    let owner = git_dir(dir)?;
    // `.git/worktrees/<name>`, not `.git/modules/<name>`: a submodule's git dir
    // has the same grandparent and is not a checkout to migrate or hand over.
    let worktrees_dir = owner.parent()?;
    if worktrees_dir.file_name() != Some(std::ffi::OsStr::new("worktrees")) {
        return None;
    }
    let common = worktrees_dir.parent()?;
    let mine = git_dir(repo)?;
    same_dir(common, &mine).then_some(owner)
}

/// Whether `dir` is one of `repo`'s worktrees, asked from both ends.
///
/// The pointer inside the checkout is the cheap answer and the usual one. It is
/// also absolute, so a repository that was moved since the worktree was cut no
/// longer matches it — and a worktree of a moved repository is exactly what is
/// waiting to be migrated. Git's own list is read from the other end, out of the
/// repository's administrative entries, which is the half that survives the
/// move.
fn is_worktree_of(repo: &Path, dir: &Path) -> bool {
    if worktree_owner_of(repo, dir).is_some() {
        return true;
    }
    list_worktrees_blocking(repo.to_string_lossy().as_ref()).is_ok_and(|entries| {
        entries
            .iter()
            .any(|entry| !entry.main && same_dir(Path::new(&entry.path), dir))
    })
}

/// Refuses a path that is not plainly a directory name.
///
/// `from` on `worktree.migrate` is the one path in that domain that comes from
/// the caller and is never checked against the registered roots: the base it has
/// to live under is an app-data directory of an earlier release, which is no
/// project's root. That makes the shape of the path the whole boundary, and no
/// prefix test resolves anything: `<base>/../..` is under `<base>` to any of
/// them, and lands wherever the caller wanted.
///
/// A relative step is refused here rather than normalised away: every path Boite
/// ever stored is a plain join, and what the check reads has to be exactly what
/// the move touches. Normalising would leave the two disagreeing.
fn plain_worktree_path(p: &Path) -> Result<(), String> {
    if !p.is_absolute() {
        return Err(format!("'{}' is not an absolute path", p.display()));
    }
    // Read off the text rather than off `Path::components`. A Windows verbatim
    // path — `\\?\C:\...`, which is what `canonicalize` hands back and what half
    // the paths in this app are — is documented as unnormalised, and its
    // components never come back as `ParentDir`: a `..` inside one is an
    // ordinary name as far as the iterator is concerned. The check would have
    // passed exactly where it matters most.
    let text = p.to_string_lossy();
    if text
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment == ".")
    {
        return Err(format!("'{}' is not a worktree path", p.display()));
    }
    Ok(())
}

/// What is left of `p` once `base` has been taken off the front, or nothing at
/// all when `p` is not under it.
///
/// Text rather than [`Path::starts_with`], for the reason `plain_worktree_path`
/// does not read components either: a verbatim path is compared component by
/// component against one spelled by hand, and a segment written with the other
/// platform's separator swallows the whole tail into one component. Both
/// spellings of the base are tried, because the host holds it as it was built
/// and the source it is checked against may have been canonicalised.
fn under_base(base: &Path, p: &Path) -> Option<String> {
    let text = norm_dir(p);
    let mut bases = vec![norm_dir(base)];
    if let Ok(real) = fs::canonicalize(base) {
        let real = norm_dir(&real);
        if real != bases[0] {
            bases.push(real);
        }
    }
    bases.iter().find_map(|base| {
        text.strip_prefix(base.as_str())?
            .strip_prefix('/')
            .map(str::to_string)
    })
}

/// Where a source handed to `worktree.migrate` sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationSource {
    /// Directly under the base this host left behind. There is something to
    /// carry across.
    Legacy,
    /// Under no base of this host's. Nothing to move, and nothing wrong either:
    /// the caller asked whether an old worktree needs carrying across, and the
    /// answer is no.
    Elsewhere,
}

/// What a caller is allowed to name as a source, decided before anything moves.
///
/// The front door owns this half because it is the only side that knows which
/// base an earlier release left behind. The refusals are the point: a source
/// that is the base itself, one climbing out of it with `..`, one two levels
/// down, and one that is a link wearing a worktree's name all reach
/// [`migrate_worktree_blocking`], which unlinks shared artifacts, deletes
/// provisioned directories and then renames the whole tree away.
pub fn classify_migration_source(base: &Path, from: &Path) -> Result<MigrationSource, String> {
    plain_worktree_path(from)?;
    if same_dir(from, base) {
        return Err("the worktree base is not a worktree".into());
    }
    // Under no base of this host's, which is the ordinary answer on a fresh
    // install and for every worktree made since the layout changed.
    let Some(name) = under_base(base, from) else {
        return Ok(MigrationSource::Elsewhere);
    };
    if name.contains('/') {
        return Err(format!(
            "'{}' is not directly under the worktree base",
            from.display()
        ));
    }
    // A link with the right name in the right place is not the directory it
    // stands for: `is_dir` follows it, `rename` moves the link rather than the
    // tree, and the artifact sweep walks into whatever it points at and deletes
    // there. Refused rather than resolved — a worktree Boite made is a real
    // directory, so a link in its place is never the thing being migrated.
    if fs::symlink_metadata(from).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!("'{}' is a link, not a worktree", from.display()));
    }
    Ok(MigrationSource::Legacy)
}

/// Whether `path` is a worktree of this repository, walking up so a cwd
/// inside one still answers. The main checkout is not: that is already
/// where the thread runs when worktrees are off.
pub fn recognize_worktree_blocking(repo: &str, path: &str) -> Option<String> {
    let r = Path::new(repo);
    let mut dir = PathBuf::from(path);
    for _ in 0..16 {
        if let Some(found) = owned_worktree_dir(r, &dir) {
            return Some(found.to_string_lossy().into_owned());
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Moves an existing worktree into its project's `.boite/worktrees`, keeping
/// everything in it.
///
/// `git worktree move` is not used, because it cannot do this job: it renames,
/// and a rename across volumes fails with `Improper link`. Migrating from a
/// base beside the database to one inside the project is precisely the
/// cross-volume case, and it is the case that matters most, since a shared
/// volume is the whole reason to migrate. What works instead is the sequence
/// git documents for a relocated worktree: put the directory where you want it,
/// then `git worktree repair`.
///
/// The provisioned directories are removed rather than carried across. They are
/// reproducible by definition, which is what puts them in the policy, and they
/// are also the only thing here big enough to make the copy slow. Removing them
/// first is what turns migrating a 20 GB worktree into copying its source, and
/// `provision_shared_artifacts` puts them back at the far end for nothing.
///
/// Links go before the copy for a harder reason: a junction copied by value is
/// the main checkout's `node_modules` duplicated into the worktree, and a
/// junction followed by a delete is that same directory emptied.
pub fn migrate_worktree_blocking(
    repo: &str,
    old: &str,
    new: &str,
) -> Result<Option<String>, String> {
    let (r, from, to) = (Path::new(repo), Path::new(old), Path::new(new));
    if from == to {
        return Ok(Some(new.to_string()));
    }
    if !r.is_dir() {
        return Err("Not a directory".into());
    }
    // The source came from a caller and nothing on the way here resolved it.
    // Everything below unlinks, deletes and renames, so the refusals happen
    // first and all of them happen here as well as at the front door: the door
    // checks the shape against the base it knows, this checks the half only the
    // repository can answer, and neither is reachable without the other having
    // run in the paths that matter.
    plain_worktree_path(from)?;
    if fs::symlink_metadata(from).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(format!("'{old}' is a link, not a worktree"));
    }
    // Gone rather than failed. A directory deleted by hand has nothing left to
    // move, and reporting that as an error left the thread pointing at it: every
    // start retried the same move, and the launch in between spawned its PTY in
    // a directory that is not there.
    if !from.is_dir() {
        return Ok(None);
    }
    // On disk, of the right shape, and still nothing to do with this
    // repository: the project's own folder, a worktree cut from somewhere else,
    // a directory a user keeps their own files in. Moving one is the same
    // damage whichever it is, and the sweep of provisioned directories that runs
    // two lines down happens inside it first.
    if !is_worktree_of(r, from) {
        return Err(format!("'{old}' is not a worktree of this repository"));
    }
    if to.exists() {
        return Err(format!("'{new}' already exists."));
    }

    unlink_shared_artifacts(r, from);
    // Whatever survived unlinking as a real directory is provisioned build
    // output or fetched dependencies, and both come back for free.
    for entry in artifact_policy(r) {
        let dir = from.join(&entry.dir);
        if let Ok(meta) = fs::symlink_metadata(&dir) {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("worktree base: {e}"))?;
    }
    // Same volume still renames, which is instant. The copy is the fallback,
    // not the plan.
    if fs::rename(from, to).is_err() {
        copy_tree(from, to).map_err(|e| {
            let _ = fs::remove_dir_all(to);
            format!("could not move the worktree: {e}")
        })?;
        fs::remove_dir_all(from)
            .map_err(|e| format!("the worktree was copied but the old one is still there: {e}"))?;
    }

    let mut repair = git(r);
    repair.args(["worktree", "repair", new]);
    run(repair)?;
    prune_stale_worktrees(r);

    ensure_boite_excluded(r);
    provision_shared_artifacts(r, to);
    // The directory is neither where nor what its old marker said. A claim
    // marker left beside a name nothing uses is the same litter a spare marker
    // would be.
    drop_claim_marker(from);
    Ok(Some(new.to_string()))
}

/// Copies a tree by value, symlinks excluded.
///
/// Every link is gone by the time this runs, and one appearing here would be
/// the bug that emptied a main checkout once already, so it is skipped rather
/// than followed.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_symlink() {
            continue;
        }
        if ty.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// One line of `git worktree list`, with what it would cost to remove it.
///
/// The repository is the authority, not Boite's thread rows: a worktree whose
/// thread was deleted still exists on disk and still holds whatever was in it,
/// and that is precisely the one nobody can see today.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    /// The branch it is on, or none when HEAD is detached — which is how every
    /// worktree Boite opens starts out.
    pub branch: Option<String>,
    pub head: String,
    /// The first one git lists is the repository's own checkout. It is in the
    /// list because leaving it out would make the numbers not add up, and it
    /// is flagged because it is the one that must never be offered for removal.
    pub main: bool,
    pub locked: bool,
    /// Git would drop this entry on the next `worktree prune`: its directory is
    /// gone, only the administrative file is left.
    pub prunable: bool,
    /// Modified, staged or untracked files. False for a worktree whose
    /// directory no longer exists, where there is nothing left to be dirty.
    pub dirty: bool,
    /// HEAD is on no local branch, so the commits here are reachable from
    /// nowhere else.
    pub orphan_commits: bool,
    /// Made ahead of time and not claimed yet: the next agent thread in this
    /// repository walks into it instead of waiting for a checkout. Removing it
    /// costs nothing but the head start.
    pub spare: bool,
}

/// Every worktree of a repository, its own checkout included.
///
/// `--porcelain` because the human format elides and aligns; each record is a
/// blank-line-separated block of `key value` lines, and the keys that carry no
/// value (`bare`, `detached`, `prunable`) appear alone.
///
/// The dirty and orphan flags cost two git invocations per worktree, which is
/// why this exists as one call rather than as a list the caller then walks: on
/// Windows the round trips are the expensive part, and a page that has to draw
/// the whole picture wants it in one answer.
pub fn list_worktrees_blocking(repo: &str) -> Result<Vec<WorktreeEntry>, String> {
    let r = Path::new(repo);
    if !r.is_dir() {
        return Err("Not a directory".into());
    }
    let mut cmd = git(r);
    cmd.args(["worktree", "list", "--porcelain"]);
    let out = run(cmd)?;
    let text = String::from_utf8_lossy(&out);

    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut path: Option<String> = None;
    let mut head = String::new();
    let mut branch: Option<String> = None;
    let mut locked = false;
    let mut prunable = false;

    // A record ends at a blank line, and the last one ends at the end of the
    // output — hence the sentinel rather than a flush after the loop.
    for line in text.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(p) = path.take() {
                let main = entries.is_empty();
                // Listed rather than hidden, and marked. It carries no thread and
                // holds no work, so a row nobody could explain would be worse
                // than one that says what it is — and hiding it would make the
                // one directory the pool keeps per repository invisible to the
                // one page that can reclaim it.
                let spare = !main && is_spare_worktree(&p);
                // A pruned-away directory cannot be inspected, and reporting it
                // as clean would invite exactly the removal that is already
                // safe. The prunable flag is what that row is about.
                let hold = worktree_hold_blocking(&p).unwrap_or(WorktreeHold {
                    dirty: false,
                    orphan_commits: false,
                });
                entries.push(WorktreeEntry {
                    path: p,
                    branch: branch.take(),
                    head: std::mem::take(&mut head),
                    main,
                    locked,
                    prunable,
                    dirty: hold.dirty,
                    orphan_commits: hold.orphan_commits,
                    spare,
                });
            }
            locked = false;
            prunable = false;
            continue;
        }
        let (key, value) = match line.split_once(' ') {
            Some((k, v)) => (k, v),
            None => (line, ""),
        };
        match key {
            "worktree" => path = Some(value.to_string()),
            "HEAD" => head = value.to_string(),
            // `refs/heads/x` is what git prints; the panel wants `x`.
            "branch" => branch = Some(value.trim_start_matches("refs/heads/").to_string()),
            "locked" => locked = true,
            "prunable" => prunable = true,
            _ => {}
        }
    }
    Ok(entries)
}

/// What each of these directories takes on disk, in bytes.
///
/// Its own call rather than a field on [`WorktreeEntry`]: listing worktrees is
/// what draws the panel, and walking every file of every checkout in front of
/// it would trade a page that appears for a number nobody asked for yet.
///
/// Links are counted as nothing, deliberately. A worktree's heavy directories
/// are junctions into the main checkout — the whole point of the pool — so
/// following one would report `node_modules` once per worktree and offer to
/// free disk that removing it would not give back. A directory that is not
/// there answers zero rather than failing: a prunable worktree is one of the
/// rows this is asked about.
pub fn worktree_sizes_blocking(paths: &[String]) -> Vec<u64> {
    paths.iter().map(|p| dir_size(Path::new(p))).collect()
}

fn dir_size(root: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ty) = entry.file_type() else { continue };
            if ty.is_symlink() {
                continue;
            }
            if ty.is_dir() {
                stack.push(entry.path());
            } else if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

#[cfg(test)]
mod worktree_tests {
    // Provisioning artifacts is something a worktree does, so what exercises it
    // lives with the lifecycle rather than beside the helpers it pokes. They are
    // `pub(super)` for exactly this and for nothing else.
    use super::super::artifacts::{
        glob_matches, is_local_artifact, is_mutable_build_artifact, link, workspace_package_names,
    };
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "boite-worktree-{tag}-{}-{nonce}-{seq}",
            std::process::id()
        ))
    }

    fn git_in(path: &Path, args: &[&str]) {
        let out = Command::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {:?}", out);
    }

    struct Fixture {
        repo: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let repo = scratch("repo");
            fs::create_dir_all(&repo).unwrap();
            git_in(&repo, &["init", "--quiet"]);
            git_in(&repo, &["config", "user.name", "Boite Test"]);
            git_in(&repo, &["config", "user.email", "boite@example.test"]);
            git_in(&repo, &["branch", "-M", "master"]);
            fs::write(repo.join("a.txt"), "one\n").unwrap();
            git_in(&repo, &["add", "a.txt"]);
            git_in(&repo, &["commit", "--quiet", "-m", "initial"]);
            Self { repo }
        }

        fn path(&self) -> &str {
            self.repo.to_str().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.repo);
        }
    }

    /// The number a sweep button promises. A directory git has already lost
    /// weighs nothing rather than failing the whole call: a prunable worktree is
    /// one of the rows that gets measured.
    #[test]
    fn a_worktree_weighs_the_files_it_holds() {
        let dir = scratch("sizes");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.bin"), vec![0u8; 2048]).unwrap();
        fs::write(dir.join("sub").join("b.bin"), vec![0u8; 1024]).unwrap();

        let gone = scratch("sizes-gone");
        let sizes = worktree_sizes_blocking(&[
            dir.to_string_lossy().to_string(),
            gone.to_string_lossy().to_string(),
        ]);
        assert_eq!(sizes, vec![3072, 0]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// A thread whose row lost its worktree path can be given it back, and only
    /// when the directory really is this repository's worktree. The refusals
    /// matter more than the hit: a wrong yes starts an agent in somebody else's
    /// checkout.
    #[test]
    fn a_thread_is_given_back_only_a_worktree_this_repository_owns() {
        let f = Fixture::new();
        assert_eq!(
            adopt_worktree_blocking(f.path(), "thread-1"),
            None,
            "nothing to give back before one exists"
        );

        let base = worktree_base_for(&f.repo);
        let dir = scoped_dir_for(&base, "thread-1");
        add_detached_worktree_blocking(f.path(), dir.to_str().unwrap()).unwrap();
        assert_eq!(
            adopt_worktree_blocking(f.path(), "thread-1").as_deref(),
            dir.to_str(),
            "the worktree it was running in"
        );

        // The right name in the right place, and not a worktree at all.
        let plain = scoped_dir_for(&base, "thread-2");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(
            adopt_worktree_blocking(f.path(), "thread-2"),
            None,
            "a directory that is not a checkout is not one to hand over"
        );

        // A worktree, but another repository's.
        let other = Fixture::new();
        let stranger = scoped_dir_for(&base, "thread-3");
        add_detached_worktree_blocking(other.path(), stranger.to_str().unwrap()).unwrap();
        assert_eq!(
            adopt_worktree_blocking(f.path(), "thread-3"),
            None,
            "a checkout of another repository is never this project's to give"
        );

        // Ours by name and by `.git`, and git no longer knows it: the entry
        // holding its HEAD and index is gone, so nothing done in there could be
        // committed. Handing it back is worse than starting in the project.
        let orphan = scoped_dir_for(&base, "thread-4");
        add_detached_worktree_blocking(f.path(), orphan.to_str().unwrap()).unwrap();
        let admin = git_dir(&orphan).unwrap();
        fs::remove_dir_all(&admin).unwrap();
        assert_eq!(
            adopt_worktree_blocking(f.path(), "thread-4"),
            None,
            "a checkout git has lost track of is not one to start a thread in"
        );
    }

    /// An agent that opened its own worktree (grok `-w`, claude's
    /// `.claude/worktrees`, `git worktree add`) is recognised from any path
    /// inside that checkout, and the main folder is not: that is already
    /// where the thread runs when worktrees are off.
    #[test]
    fn a_foreign_worktree_of_this_repository_is_recognised() {
        let f = Fixture::new();
        assert_eq!(
            recognize_worktree_blocking(f.path(), f.path()),
            None,
            "the main checkout is not a worktree to adopt"
        );

        let inside = f.repo.join("src");
        fs::create_dir_all(&inside).unwrap();
        assert_eq!(
            recognize_worktree_blocking(f.path(), inside.to_str().unwrap()),
            None,
            "a folder of the main checkout is still the main checkout"
        );

        let agent = scratch("agent-wt");
        add_detached_worktree_blocking(f.path(), agent.to_str().unwrap()).unwrap();
        assert_eq!(
            recognize_worktree_blocking(f.path(), agent.to_str().unwrap()).as_deref(),
            agent.to_str(),
            "a worktree git knows, wherever it lives"
        );

        let nested = agent.join("src");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            recognize_worktree_blocking(f.path(), nested.to_str().unwrap()).as_deref(),
            agent.to_str(),
            "a cwd inside the worktree still names the checkout"
        );

        let other = Fixture::new();
        assert_eq!(
            recognize_worktree_blocking(f.path(), other.path()),
            None,
            "another repository is never this project's worktree"
        );
    }

    /// The window this closes: a spare is renamed to its thread's name, and
    /// `git worktree repair` has not yet told git where it went. A prune in
    /// that instant — one runs per thread closed, and closing several while
    /// opening one is an ordinary afternoon — deletes the entry holding the
    /// worktree's HEAD and index, and nothing can put it back.
    #[test]
    fn pruning_leaves_alone_an_entry_whose_directory_has_just_moved() {
        let f = Fixture::new();
        let base = worktree_base_for(&f.repo);
        let from = scoped_dir_for(&base, "spare-1");
        add_detached_worktree_blocking(f.path(), from.to_str().unwrap()).unwrap();
        let admin = git_dir(&from).unwrap();

        // Mid-rename: on disk at the new name, and git still pointed at the old.
        let to = scoped_dir_for(&base, "thread-1");
        fs::rename(&from, &to).unwrap();
        prune_stale_worktrees(&f.repo);
        assert!(
            admin.is_dir(),
            "the entry was pruned out from under a directory that had only moved"
        );

        // And the repair that follows still lands, which is the whole point.
        let mut repair = git(&f.repo);
        repair.args(["worktree", "repair", &to.to_string_lossy()]);
        run(repair).unwrap();
        assert_eq!(
            adopt_worktree_blocking(f.path(), "thread-1").as_deref(),
            to.to_str(),
            "the renamed worktree is not usable again"
        );
    }

    /// HEAD is read off the filesystem rather than through `git rev-parse`, so
    /// every shape it comes in has to be recognised: unborn (a symref to a
    /// branch that has no commit), loose, packed, and detached.
    #[test]
    fn head_is_resolved_without_asking_git() {
        let empty = scratch("empty");
        fs::create_dir_all(&empty).unwrap();
        git_in(&empty, &["init", "--quiet"]);
        assert!(
            !head_has_commit(&empty),
            "an unborn HEAD has no commit to detach from"
        );
        let w = scratch("w-empty");
        assert_eq!(
            add_detached_worktree_blocking(empty.to_str().unwrap(), w.to_str().unwrap()),
            Err("This repository has no commits yet.".into()),
        );
        assert!(!w.exists());
        let _ = fs::remove_dir_all(&empty);

        let f = Fixture::new();
        assert!(head_has_commit(&f.repo), "a loose ref is a commit");
        // Packed: the loose file under refs/heads is gone and the ref only
        // exists as a line in packed-refs.
        git_in(&f.repo, &["pack-refs", "--all"]);
        assert!(
            !f.repo.join(".git/refs/heads/master").is_file(),
            "pack-refs should have removed the loose ref"
        );
        assert!(head_has_commit(&f.repo), "a packed ref is a commit too");

        // Detached, and through a linked worktree, whose own HEAD sits in
        // .git/worktrees/<name> while its refs stay with the main checkout.
        let linked = scratch("linked");
        assert!(add_detached_worktree_blocking(f.path(), linked.to_str().unwrap()).is_ok());
        assert!(head_has_commit(&linked), "a detached HEAD is an object id");
        let _ = remove_worktree_blocking(f.path(), linked.to_str().unwrap(), true);
    }

    /// A ref is allowed to name another ref, and git writes that itself for
    /// `HEAD -> refs/heads/master` on a repository whose default branch was
    /// renamed through a symbolic ref. Stopping at the first hop reads a working
    /// repository as one with no commits.
    #[test]
    fn head_follows_a_ref_that_names_another_ref() {
        let f = Fixture::new();
        let real = head_oid(&f.repo).expect("the fixture has a commit");

        // HEAD -> refs/heads/alias -> refs/heads/master -> <oid>.
        fs::write(f.repo.join(".git/refs/heads/alias"), "ref: refs/heads/master\n").unwrap();
        fs::write(f.repo.join(".git/HEAD"), "ref: refs/heads/alias\n").unwrap();
        assert_eq!(
            head_oid(&f.repo).as_deref(),
            Some(real.as_str()),
            "a chain of symrefs still ends at the commit"
        );
        assert!(head_has_commit(&f.repo));

        // A chain that closes on itself is a broken repository, and has to
        // answer rather than read files forever.
        fs::write(f.repo.join(".git/refs/heads/alias"), "ref: refs/heads/alias\n").unwrap();
        assert_eq!(head_oid(&f.repo), None, "a cycle is not a commit");
    }

    /// A ref that outlived its object. `worktree add` answers that with a
    /// message about an invalid reference, which is the message the guard is
    /// there to replace — so the guard has to see it, and reading the ref file
    /// alone cannot.
    #[test]
    fn a_ref_pointing_at_nothing_is_not_a_commit() {
        let f = Fixture::new();
        let real = head_oid(&f.repo).expect("the fixture has a commit");
        let master = f.repo.join(".git/refs/heads/master");

        let dangling = "0123456789abcdef0123456789abcdef01234567";
        fs::write(&master, format!("{dangling}\n")).unwrap();
        assert_eq!(head_oid(&f.repo).as_deref(), Some(dangling), "the ref reads");
        assert!(!head_has_commit(&f.repo), "but nothing is behind it");

        let w = scratch("w-dangling");
        assert_eq!(
            add_detached_worktree_blocking(f.path(), w.to_str().unwrap()),
            Err("This repository has no commits yet.".into()),
        );
        assert!(!w.exists());

        // The same question, once the object is packed rather than loose. A
        // freshly cloned repository has no loose objects at all, so a check that
        // only looked at `objects/xx/` would answer "no commits yet" on every
        // one of them.
        fs::write(&master, format!("{real}\n")).unwrap();
        git_in(&f.repo, &["repack", "-ad"]);
        git_in(&f.repo, &["prune-packed"]);
        assert!(
            !f.repo
                .join(format!(".git/objects/{}/{}", &real[..2], &real[2..]))
                .is_file(),
            "repack should have swept the loose object"
        );
        assert!(head_has_commit(&f.repo), "a packed commit is still a commit");
    }

    /// A ref is allowed to point at any object, and `worktree add --detach`
    /// needs a commit. An object that exists but is a tree has to be refused
    /// here rather than by git, or the user reads a message about an invalid
    /// reference instead of the guard's own.
    #[test]
    fn a_ref_pointing_at_a_non_commit_is_refused() {
        let f = Fixture::new();
        let mut cmd = git(&f.repo);
        cmd.args(["rev-parse", "HEAD^{tree}"]);
        let tree = String::from_utf8(run(cmd).unwrap())
            .unwrap()
            .trim()
            .to_string();

        fs::write(f.repo.join(".git/refs/heads/master"), format!("{tree}\n")).unwrap();
        assert_eq!(
            head_oid(&f.repo).as_deref(),
            Some(tree.as_str()),
            "the ref reads, and the object is really there"
        );
        assert!(
            !head_has_commit(&f.repo),
            "an existing tree is still not something to check out"
        );

        let w = scratch("w-tree");
        assert_eq!(
            add_detached_worktree_blocking(f.path(), w.to_str().unwrap()),
            Err("This repository has no commits yet.".into()),
        );
        assert!(!w.exists());
    }

    /// Every answer the eligibility check has to give, since it is the only
    /// thing standing between a thread and a worktree.
    #[test]
    fn eligibility_refuses_a_non_repo_and_a_checkout_holding_tracked_work() {
        let plain = scratch("plain");
        fs::create_dir_all(&plain).unwrap();
        let base = scratch("base-plain");
        assert_eq!(
            open_worktree_if_eligible_blocking(
                plain.to_str().unwrap(),
                base.to_str().unwrap(),
                "t1",
            ),
            Ok(WorktreeOpening::default()),
            "a non-repo has no worktree to open and nothing to explain"
        );
        assert!(
            !base.join("t1").exists(),
            "a non-repo must not get a worktree"
        );
        let _ = fs::remove_dir_all(&plain);
        let _ = fs::remove_dir_all(&base);

        let f = Fixture::new();
        // Clean, and nothing standing by: a worktree named after the thread,
        // under the base.
        let base = scratch("base-clean");
        let made = open_worktree_if_eligible_blocking(f.path(), base.to_str().unwrap(), "t1");
        assert_eq!(
            made,
            Ok(WorktreeOpening::at(
                base.join("t1").to_string_lossy().into_owned()
            )),
        );
        assert!(base.join("t1").join("a.txt").is_file());
        let _ = remove_worktree_blocking(
            f.path(),
            base.join("t1").to_str().unwrap(),
            true,
        );

        // An untracked file does not count. A tool that drops a directory
        // nobody ignored is not work in flight, and it used to turn worktrees
        // off for the whole project without saying so.
        let untracked = scratch("base-untracked");
        fs::write(f.repo.join("scratch.txt"), "wip\n").unwrap();
        assert_eq!(
            open_worktree_if_eligible_blocking(f.path(), untracked.to_str().unwrap(), "t2"),
            Ok(WorktreeOpening::at(
                untracked.join("t2").to_string_lossy().into_owned()
            )),
        );
        let _ = remove_worktree_blocking(
            f.path(),
            untracked.join("t2").to_str().unwrap(),
            true,
        );

        // A tracked file that changed does count: that is the work under
        // discussion, so the thread starts where it is and is told why.
        let dirty = scratch("base-dirty");
        fs::write(f.repo.join("a.txt"), "changed\n").unwrap();
        assert_eq!(
            open_worktree_if_eligible_blocking(f.path(), dirty.to_str().unwrap(), "t3"),
            Ok(WorktreeOpening {
                path: None,
                dirty: vec!["a.txt".into()],
                more: false,
            }),
            "the refusal names what caused it, since nothing downstream can find out"
        );
        assert!(!dirty.join("t3").exists());
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&untracked);
        let _ = fs::remove_dir_all(&dirty);
    }

    /// The sample the toast reads from: a few names, and whether there were
    /// others. Staged, unstaged and renamed all have to arrive as paths.
    #[test]
    fn tracked_changes_names_a_few_and_says_there_are_more() {
        let f = Fixture::new();
        assert_eq!(
            tracked_changes(&f.repo),
            Ok(MainCheckoutWork::default()),
            "a clean checkout holds nothing"
        );

        for i in 0..DIRTY_SAMPLE + 2 {
            fs::write(f.repo.join(format!("f{i}.txt")), "x\n").unwrap();
        }
        git_in(&f.repo, &["add", "."]);
        git_in(&f.repo, &["commit", "--quiet", "-m", "more files"]);

        for i in 0..DIRTY_SAMPLE + 2 {
            fs::write(f.repo.join(format!("f{i}.txt")), "changed\n").unwrap();
        }
        let found = tracked_changes(&f.repo).unwrap();
        assert_eq!(
            found.files.len(),
            DIRTY_SAMPLE,
            "the sample is capped at what fits in a message"
        );
        assert!(found.more, "and the rest is reported as a count, not a list");
        assert!(
            found.files.iter().all(|name| name.starts_with("f")),
            "porcelain status letters are not part of a path: {:?}",
            found.files
        );
    }

    /// The one porcelain line that is not `XY path`.
    #[test]
    fn a_renamed_file_arrives_under_the_name_it_has_now() {
        assert_eq!(
            porcelain_path("R  old/name.txt -> new/name.txt").as_deref(),
            Some("new/name.txt"),
        );
        assert_eq!(porcelain_path(" M src/lib.rs").as_deref(), Some("src/lib.rs"));
        assert_eq!(porcelain_path("M  \"quoted path.txt\"").as_deref(), Some("quoted path.txt"));
        assert_eq!(porcelain_path("").as_deref(), None);
    }

    /// The pool, which is the difference between a thread that waits for a
    /// checkout and one that walks into a finished one.
    #[test]
    fn a_spare_is_made_ahead_and_handed_to_the_next_thread() {
        let f = Fixture::new();
        let base = scratch("pool");
        fs::create_dir_all(&base).unwrap();
        let base_s = base.to_str().unwrap().to_string();

        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        let spares = read_spares(&base, Some(&f.repo));
        assert_eq!(
            spares.len(),
            READY_SPARES,
            "warming fills the pool, so a burst of launches costs what one costs"
        );
        let dirs: Vec<_> = spares.iter().map(|s| s.dir.clone()).collect();
        for dir in &dirs {
            assert!(dir.join("a.txt").is_file(), "a spare is a real checkout");
        }

        // Warming again keeps the ones that are already there.
        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        assert_eq!(read_spares(&base, Some(&f.repo)).len(), READY_SPARES);

        let listed = list_worktrees_blocking(f.path()).unwrap();
        for dir in &dirs {
            let row = listed
                .iter()
                .find(|e| same_dir(Path::new(&e.path), dir))
                .expect("a spare is listed, so the page that can reclaim it sees it");
            assert!(row.spare, "and it says what it is");
        }

        // The next thread walks into one of them, and it stops being a spare:
        // the marker goes, and the directory takes the thread's name so nothing
        // downstream reads it as one of the pool's own.
        let taken = open_worktree_if_eligible_blocking(f.path(), &base_s, "t1")
            .unwrap()
            .path
            .expect("a spare is standing by");
        assert_eq!(
            Path::new(&taken),
            scoped_dir_for(&base, "t1"),
            "a claimed spare is renamed after the thread that took it"
        );
        assert!(
            dirs.iter().any(|d| !d.exists()),
            "a thread is handed a checkout that was already finished"
        );
        assert!(
            Path::new(&taken).join("a.txt").is_file(),
            "and it is the whole checkout, not an empty directory"
        );
        assert!(
            !is_spare_worktree(&taken),
            "claiming a spare is deleting its marker"
        );
        let listed = list_worktrees_blocking(f.path()).unwrap();
        let row = listed
            .iter()
            .find(|e| same_dir(Path::new(&e.path), Path::new(&taken)))
            .expect("a claimed worktree is listed like any other");
        assert!(!row.spare, "and is no longer standing by");

        // What the second launch of a burst finds. With one spare in the pool
        // this was empty, and that thread paid for its own checkout.
        assert!(
            read_spares(&base, Some(&f.repo))
                .iter()
                .any(|s| !same_dir(&s.dir, Path::new(&taken))),
            "a claim leaves something standing by for the launch after it"
        );

        let _ = remove_worktree_blocking(f.path(), &taken, true);
        for dir in &dirs {
            let _ = remove_worktree_blocking(f.path(), dir.to_str().unwrap(), true);
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// A spare is only useful if it is on the commit the project is on: a thread
    /// that starts one commit behind is looking at the wrong code.
    #[test]
    fn a_spare_made_before_a_commit_is_brought_forward() {
        let f = Fixture::new();
        let base = scratch("pool-stale");
        fs::create_dir_all(&base).unwrap();
        let base_s = base.to_str().unwrap().to_string();

        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        let dir = read_spares(&base, Some(&f.repo))[0].dir.clone();
        assert!(!dir.join("b.txt").exists());

        fs::write(f.repo.join("b.txt"), "two\n").unwrap();
        git_in(&f.repo, &["add", "b.txt"]);
        git_in(&f.repo, &["commit", "--quiet", "-m", "second"]);

        let taken = open_worktree_if_eligible_blocking(f.path(), &base_s, "t1")
            .unwrap()
            .path
            .expect("the spare is still the one used");
        assert!(!dir.exists(), "the spare was renamed rather than left behind");
        assert!(
            Path::new(&taken).join("b.txt").is_file(),
            "it has to carry the commit made after it was created"
        );

        let _ = remove_worktree_blocking(f.path(), &taken, true);
        let _ = fs::remove_dir_all(&base);
    }

    /// Bringing a spare forward is a `git checkout --detach` the thread waits
    /// through, so a pool holding both kinds has to hand over the one that needs
    /// nothing done to it.
    #[test]
    fn a_ready_spare_is_preferred_over_one_that_is_behind() {
        let f = Fixture::new();
        let base = scratch("pool-order");
        fs::create_dir_all(&base).unwrap();

        // Named so the pool lists this one first: the directory order is what an
        // ordering that ignored `HEAD` would follow, so a test that let the
        // ready one come up first would pass either way.
        let stale = base.join("spare-a-behind");
        add_detached_worktree_blocking(f.path(), &stale.to_string_lossy()).unwrap();
        write_spare_marker(&stale, &f.repo, &head_oid(&f.repo).unwrap()).unwrap();

        fs::write(f.repo.join("b.txt"), "two\n").unwrap();
        git_in(&f.repo, &["add", "b.txt"]);
        git_in(&f.repo, &["commit", "--quiet", "-m", "second"]);

        let fresh = base.join("spare-b-ready");
        add_detached_worktree_blocking(f.path(), &fresh.to_string_lossy()).unwrap();
        write_spare_marker(&fresh, &f.repo, &head_oid(&f.repo).unwrap()).unwrap();

        let taken = take_spare(&base, &f.repo).expect("the pool has something to give");
        assert!(
            same_dir(Path::new(&taken), &fresh),
            "a thread is handed the spare that is already on the commit"
        );
        assert!(
            is_spare_worktree(stale.to_str().unwrap()),
            "and the one that is behind is left in the pool for warming to fix"
        );
        assert!(
            !stale.join("b.txt").exists(),
            "nothing checked it out on the way past"
        );

        let _ = remove_worktree_blocking(f.path(), &taken, true);
        let _ = remove_worktree_blocking(f.path(), stale.to_str().unwrap(), true);
        let _ = fs::remove_dir_all(&base);
    }

    /// The one thing the pool must never do: run `git checkout --detach` inside
    /// a directory an agent has already been handed. Warming brings a spare
    /// forward when the project has moved on, and a thread claims one by
    /// deleting its marker — so both have to be asking the same question, and
    /// the loser has to walk away.
    #[test]
    fn warming_will_not_touch_a_worktree_that_has_just_been_claimed() {
        let f = Fixture::new();
        let base = scratch("pool-race");
        fs::create_dir_all(&base).unwrap();
        let base_s = base.to_str().unwrap().to_string();

        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();

        // The project moves on, so the next warm has a reason to check the
        // spares out again.
        fs::write(f.repo.join("b.txt"), "two\n").unwrap();
        git_in(&f.repo, &["add", "b.txt"]);
        git_in(&f.repo, &["commit", "--quiet", "-m", "second"]);

        // Warming's own read of the pool, taken before anything else happens.
        // Everything below is what can land between that read and the checkout
        // it was about to run.
        let seen = read_spares(&base, Some(&f.repo));
        assert_eq!(seen.len(), READY_SPARES);
        let head = head_oid(&f.repo).unwrap();
        for spare in &seen {
            assert_ne!(spare.head, head, "they are behind");
        }

        // The thread wins the claim, and its agent starts writing.
        let taken = take_spare(&base, &f.repo).expect("the spare is claimable");
        let dir = Path::new(&taken).to_path_buf();
        let claimed = seen
            .iter()
            .find(|s| same_dir(&s.dir, &dir))
            .expect("what the thread was handed came out of the pool");
        assert!(!is_spare_worktree(&taken), "and stops being a spare");
        fs::write(dir.join("agent-notes.md"), "work in progress\n").unwrap();

        // Warming resumes, holding the stale listing. The marker is the gate,
        // and it is gone: this is the exact line that used to be a bare
        // `detach_to` on the directory the thread now owns.
        assert!(
            !take_marker(&claimed.dir),
            "a claimed spare must refuse warming the same way it refuses a second thread"
        );

        // And the whole call, for good measure.
        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();

        assert!(
            dir.join("agent-notes.md").is_file(),
            "warming ran a checkout in a claimed worktree and destroyed its untracked files"
        );
        assert!(
            !is_spare_worktree(&taken),
            "and it must not have been put back in the pool"
        );
        // It made itself another one instead, which is the whole answer: the
        // claimed directory is nobody's business but the thread's.
        let spares = read_spares(&base, Some(&f.repo));
        assert_eq!(spares.len(), READY_SPARES, "fresh spares, not the claimed one");
        assert!(
            spares.iter().all(|s| !same_dir(&s.dir, &dir)),
            "and the claimed directory is not among them"
        );

        for spare in &spares {
            let _ = remove_worktree_blocking(f.path(), spare.dir.to_str().unwrap(), true);
        }
        let _ = remove_worktree_blocking(f.path(), &taken, true);
        let _ = fs::remove_dir_all(&base);
    }

    /// A spare is a whole checkout, made on project selection, and it used to be
    /// kept forever: looking at twenty projects wrote twenty of them and nothing
    /// took one back.
    #[test]
    fn the_pool_is_capped_by_count_and_by_age() {
        let f = Fixture::new();
        let base = scratch("pool-cap");
        fs::create_dir_all(&base).unwrap();
        let base_s = base.to_str().unwrap().to_string();

        // More spares than the cap allows, each one a real worktree of this
        // repository, as warming would have left them over several sessions.
        let mut made = Vec::new();
        for i in 0..(MAX_SPARES + 2) {
            let dir = base.join(format!("spare-{i}"));
            add_detached_worktree_blocking(f.path(), &dir.to_string_lossy()).unwrap();
            write_spare_marker(&dir, &f.repo, &head_oid(&f.repo).unwrap()).unwrap();
            made.push(dir);
        }
        assert_eq!(read_spares(&base, None).len(), MAX_SPARES + 2);

        // Through the ordinary door: warming is the only thing that grows the
        // pool, so it is also where it is brought back inside its bounds.
        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        assert_eq!(
            read_spares(&base, None).len(),
            MAX_SPARES,
            "the cap is the cap"
        );

        // Age, independent of the count: a marker old enough that its copy of
        // the shared directories cannot be trusted goes even under the cap.
        let left = read_spares(&base, None);
        let ancient = left[0].dir.clone();
        fs::write(
            spare_marker(&ancient).unwrap(),
            format!(
                "repo={}\nhead={}\nat={}\n",
                f.repo.display(),
                head_oid(&f.repo).unwrap(),
                now_secs() - SPARE_MAX_AGE.as_secs() - 1,
            ),
        )
        .unwrap();
        warm_worktree_pool_blocking(f.path(), &base_s).unwrap();
        assert!(
            !ancient.exists(),
            "an expired spare is removed, not just unmarked"
        );
        assert_eq!(read_spares(&base, None).len(), MAX_SPARES - 1);

        for dir in made {
            let _ = remove_worktree_blocking(f.path(), dir.to_str().unwrap(), true);
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// A directory the pool made, whose marker is gone and whose thread never
    /// came: interrupt the app between the claim and the rename, or fail the
    /// marker write that puts a reworked spare back, and it stays registered as
    /// a worktree nobody owns. Before this it was invisible to the pool and to
    /// the cap, so it never went away.
    #[test]
    fn a_pool_directory_nobody_claimed_is_collected_once_it_is_old() {
        let f = Fixture::new();
        let base = scratch("pool-orphan");
        fs::create_dir_all(&base).unwrap();

        let orphan = base.join("spare-left-behind");
        add_detached_worktree_blocking(f.path(), &orphan.to_string_lossy()).unwrap();

        let standing_by = base.join("spare-in-the-pool");
        add_detached_worktree_blocking(f.path(), &standing_by.to_string_lossy()).unwrap();
        write_spare_marker(&standing_by, &f.repo, &head_oid(&f.repo).unwrap()).unwrap();

        let thread_dir = scoped_dir_for(&base, "t1");
        add_detached_worktree_blocking(f.path(), &thread_dir.to_string_lossy()).unwrap();

        // The claim window, which is milliseconds wide: nothing is swept yet.
        sweep_orphan_spares(&base, &f.repo, now_secs());
        assert!(orphan.is_dir(), "a claim in flight must survive the sweep");

        sweep_orphan_spares(&base, &f.repo, now_secs() + SPARE_MAX_AGE.as_secs() + 1);
        assert!(!orphan.exists(), "a pool directory nobody owns is collected");
        assert!(
            standing_by.is_dir(),
            "one that is still in the pool belongs to the cap, not to this"
        );
        assert!(
            thread_dir.is_dir(),
            "and a thread's own checkout is never a pool name"
        );

        let _ = remove_worktree_blocking(f.path(), standing_by.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(f.path(), thread_dir.to_str().unwrap(), true);
        let _ = fs::remove_dir_all(&base);
    }

    /// The whole reason for detaching: two of them on the same commit, which
    /// `worktree add <branch>` would reject as already checked out.
    #[test]
    fn two_detached_worktrees_can_sit_on_the_same_commit() {
        let f = Fixture::new();
        let a = scratch("a");
        let b = scratch("b");
        add_detached_worktree_blocking(f.path(), a.to_str().unwrap()).unwrap();
        add_detached_worktree_blocking(f.path(), b.to_str().unwrap()).unwrap();
        assert!(a.join("a.txt").is_file());
        assert!(b.join("a.txt").is_file());
        // And neither invented a branch to do it.
        assert!(symbolic_branch(&a).is_none());
        assert!(symbolic_branch(&b).is_none());
        let _ = remove_worktree_blocking(f.path(), a.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(f.path(), b.to_str().unwrap(), true);
    }

    #[test]
    fn listing_names_the_main_checkout_and_carries_each_worktree_state() {
        let f = Fixture::new();

        // Alone, the repository is its own only worktree.
        let solo = list_worktrees_blocking(f.path()).unwrap();
        assert_eq!(solo.len(), 1);
        assert!(solo[0].main);
        assert_eq!(solo[0].branch.as_deref(), Some("master"));
        assert!(!solo[0].dirty && !solo[0].orphan_commits);

        let dirty = scratch("list-dirty");
        add_detached_worktree_blocking(f.path(), dirty.to_str().unwrap()).unwrap();
        fs::write(dirty.join("scratch.txt"), "in flight\n").unwrap();

        let clean = scratch("list-clean");
        add_detached_worktree_blocking(f.path(), clean.to_str().unwrap()).unwrap();

        let all = list_worktrees_blocking(f.path()).unwrap();
        assert_eq!(all.len(), 3, "{all:?}");
        assert_eq!(all.iter().filter(|w| w.main).count(), 1);

        let found = |p: &Path| {
            all.iter()
                .find(|w| Path::new(&w.path) == p || w.path.contains(p.file_name().unwrap().to_str().unwrap()))
                .unwrap_or_else(|| panic!("{p:?} missing from {all:?}"))
        };

        // The untracked file is the whole point: it is work, and the list has
        // to say so without anyone opening the directory.
        assert!(found(&dirty).dirty);
        assert!(!found(&clean).dirty);
        // Detached is how every worktree Boite opens starts, so both sit on no
        // branch and their commits would go away with the directory.
        assert!(found(&dirty).branch.is_none());
        assert!(found(&clean).branch.is_none());

        let _ = remove_worktree_blocking(f.path(), dirty.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(f.path(), clean.to_str().unwrap(), true);
    }

    #[test]
    fn a_fresh_worktree_holds_nothing_and_is_removable() {
        let f = Fixture::new();
        let w = scratch("fresh");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        let hold = worktree_hold_blocking(w.to_str().unwrap()).unwrap();
        assert!(!hold.holds_work(), "{hold:?}");

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), false).unwrap();
        assert!(!w.exists());
    }

    #[test]
    fn an_untracked_file_is_enough_to_refuse_removal() {
        let f = Fixture::new();
        let w = scratch("untracked");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        fs::write(w.join("scratch.md"), "notes\n").unwrap();

        let hold = worktree_hold_blocking(w.to_str().unwrap()).unwrap();
        assert!(hold.dirty);
        assert!(remove_worktree_blocking(f.path(), w.to_str().unwrap(), false).is_err());
        assert!(w.exists(), "the refusal must not have deleted anything");

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), true).unwrap();
    }

    /// An agent that commits without ever claiming a branch. Losing this is
    /// exactly what the guard exists to prevent.
    #[test]
    fn commits_on_no_branch_refuse_removal() {
        let f = Fixture::new();
        let w = scratch("orphan");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        fs::write(w.join("b.txt"), "work\n").unwrap();
        git_in(&w, &["add", "b.txt"]);
        git_in(&w, &["commit", "--quiet", "-m", "agent work"]);

        let hold = worktree_hold_blocking(w.to_str().unwrap()).unwrap();
        assert!(!hold.dirty, "committed, so the tree is clean");
        assert!(hold.orphan_commits);
        assert!(remove_worktree_blocking(f.path(), w.to_str().unwrap(), false).is_err());

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), true).unwrap();
    }

    /// Claiming is what makes the work safe: the branch keeps the commits, so
    /// the directory is free to go.
    #[test]
    fn claiming_a_branch_makes_the_worktree_removable_again() {
        let f = Fixture::new();
        let w = scratch("claimed");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        fs::write(w.join("b.txt"), "work\n").unwrap();
        git_in(&w, &["add", "b.txt"]);
        git_in(&w, &["commit", "--quiet", "-m", "agent work"]);

        claim_worktree_branch_blocking(w.to_str().unwrap(), "feat/agent-work").unwrap();
        assert_eq!(symbolic_branch(&w).as_deref(), Some("feat/agent-work"));

        let hold = worktree_hold_blocking(w.to_str().unwrap()).unwrap();
        assert!(!hold.holds_work(), "the branch holds the commits now: {hold:?}");
        remove_worktree_blocking(f.path(), w.to_str().unwrap(), false).unwrap();

        // The branch outlived the directory, which is the point.
        let out = Command::new("git")
            .current_dir(&f.repo)
            .args(["branch", "--list", "feat/agent-work"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&out.stdout).trim().is_empty());
    }

    #[test]
    fn a_claim_refuses_a_name_that_is_taken_or_malformed() {
        let f = Fixture::new();
        let w = scratch("names");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        assert!(claim_worktree_branch_blocking(w.to_str().unwrap(), "master").is_err());
        assert!(claim_worktree_branch_blocking(w.to_str().unwrap(), "bad name").is_err());
        // `--help` exits 0 and creates nothing, so it must be caught by name.
        assert!(claim_worktree_branch_blocking(w.to_str().unwrap(), "--help").is_err());
        assert!(symbolic_branch(&w).is_none(), "still detached");

        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
    }

    /// The one that matters: removing a worktree must not reach through a link
    /// into the main checkout. A real `node_modules` was destroyed this way
    /// while this feature was being written.
    #[test]
    fn removing_a_worktree_leaves_the_shared_directories_alone() {
        let f = Fixture::new();
        let deps = f.repo.join("node_modules");
        fs::create_dir_all(deps.join("some-package")).unwrap();
        fs::write(deps.join("some-package/index.js"), "module.exports = 1\n").unwrap();

        let w = scratch("shared");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        let linked = w.join("node_modules");
        // Linking can legitimately fail (no permission, no junction support);
        // the removal below is the assertion either way.
        let was_linked = fs::symlink_metadata(&linked).is_ok();
        if was_linked {
            assert!(linked.join("some-package/index.js").is_file(), "link resolves");
        }

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), true).unwrap();

        assert!(
            deps.join("some-package/index.js").is_file(),
            "the main checkout's node_modules was emptied through the link"
        );
    }

    /// Build output must never be shared, whatever the filesystem can do. On a
    /// volume with copy-on-write the worktree gets its own `target`; on one
    /// without, it gets none and the build makes it. What it must never get is
    /// a link, because two worktrees of one package share an artifact slot and
    /// the second build silently replaces the first's binary.
    #[test]
    fn a_worktree_never_shares_build_output_with_the_main_checkout() {
        let f = Fixture::new();
        // Asked for explicitly, because the rule under test is what happens to
        // build output a project shares on purpose.
        share_target(&f);
        let out = f.repo.join("target/debug");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("app"), "main checkout\n").unwrap();

        let w = scratch("build-output");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        let theirs = w.join("target");
        if let Ok(meta) = fs::symlink_metadata(&theirs) {
            assert!(!meta.file_type().is_symlink(), "target was shared by link");
            // A clone starts identical and diverges. Writing to it is the whole
            // point, so the main checkout has to be unaffected by that write.
            fs::write(theirs.join("debug/app"), "worktree\n").unwrap();
            assert_eq!(fs::read_to_string(out.join("app")).unwrap(), "main checkout\n");
        }

        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
        assert_eq!(
            fs::read_to_string(out.join("app")).unwrap(),
            "main checkout\n",
            "removing the worktree reached into the main checkout's target"
        );
    }

    /// A repository with a manifest and a plausible `target`, which is what
    /// `hardlink_build_output` needs before it will do anything at all.
    ///
    /// The policy is written out rather than left to detection: detection does
    /// not ask for build output any more, so a project that wants it says so,
    /// and that file is the shape it says it in.
    fn with_cargo_target(f: &Fixture) {
        share_target(f);
        fs::write(
            f.repo.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/demo-core\"]\n",
        )
        .unwrap();
        fs::create_dir_all(f.repo.join("crates/demo-core")).unwrap();
        fs::write(
            f.repo.join("crates/demo-core/Cargo.toml"),
            "[package]\nname = \"demo-core\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();

        let debug = f.repo.join("target/debug");
        for dir in ["deps", "build", ".fingerprint", "incremental"] {
            fs::create_dir_all(debug.join(dir)).unwrap();
        }
        // A registry dependency: identical in every worktree, never rewritten.
        fs::write(debug.join("deps/libserde-0123456789abcdef.rlib"), "serde\n").unwrap();
        // This repository's own crate, in both spellings cargo uses.
        fs::write(debug.join("deps/libdemo_core-fedcba9876543210.rlib"), "mine\n").unwrap();
        fs::create_dir_all(debug.join(".fingerprint/demo-core-fedcba9876543210")).unwrap();
        fs::write(
            debug.join(".fingerprint/demo-core-fedcba9876543210/lib-demo_core"),
            "fp\n",
        )
        .unwrap();
        fs::create_dir_all(debug.join(".fingerprint/serde-0123456789abcdef")).unwrap();
        fs::write(
            debug.join(".fingerprint/serde-0123456789abcdef/lib-serde"),
            "fp\n",
        )
        .unwrap();
        // The uplifted final artifact, and the lock beside it.
        fs::write(debug.join("demo.exe"), "main checkout\n").unwrap();
        fs::write(debug.join(".cargo-lock"), "").unwrap();
        fs::write(debug.join("incremental/demo-core-1.bin"), "inc\n").unwrap();

        git_in(&f.repo, &["add", "Cargo.toml", "crates"]);
        git_in(&f.repo, &["commit", "--quiet", "-m", "manifest"]);
    }

    /// Asks for `target`, per file, the way a Rust project that wants it has to
    /// now that detection stops at install directories.
    fn share_target(f: &Fixture) {
        fs::create_dir_all(f.repo.join(".boite")).unwrap();
        fs::write(
            f.repo.join(POLICY_FILE),
            r#"{"shared":[{"dir":"target","mode":"hardlink","cargoWorkspace":true}]}"#,
        )
        .unwrap();
    }

    /// The whole point of the fallback: the dependency artifacts arrive without
    /// costing disk, and nothing a build rewrites comes with them.
    ///
    /// macOS takes `clonefile` first, which is copy-on-write: a write through
    /// the main checkout does not appear in the worktree. This assertion is
    /// about hard links, the path Linux and Windows actually take.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn build_output_arrives_as_links_for_dependencies_only() {
        let f = Fixture::new();
        with_cargo_target(&f);

        let w = scratch("hardlink");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        let theirs = w.join("target/debug");

        // Nothing else in this test creates these, so their presence is the
        // provisioning having run.
        assert!(
            theirs.join("deps/libserde-0123456789abcdef.rlib").is_file(),
            "the dependency artifact was not provisioned"
        );
        assert!(
            theirs.join(".fingerprint/serde-0123456789abcdef/lib-serde").is_file(),
            "the dependency fingerprint was not provisioned"
        );

        // A hard link is two names for one set of blocks, so a write through
        // one is visible through the other. This is exactly why the mutable
        // artifacts below are excluded rather than linked.
        fs::write(
            f.repo.join("target/debug/deps/libserde-0123456789abcdef.rlib"),
            "rebuilt\n",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(theirs.join("deps/libserde-0123456789abcdef.rlib")).unwrap(),
            "rebuilt\n",
            "the dependency artifact was copied rather than linked"
        );

        for excluded in [
            "demo.exe",
            ".cargo-lock",
            "deps/libdemo_core-fedcba9876543210.rlib",
            ".fingerprint/demo-core-fedcba9876543210/lib-demo_core",
            "incremental/demo-core-1.bin",
        ] {
            assert!(
                !theirs.join(excluded).exists(),
                "{excluded} was linked, and this worktree would write the main checkout's copy"
            );
        }

        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
        assert!(
            f.repo.join("target/debug/demo.exe").is_file(),
            "removing the worktree reached into the main checkout's target"
        );
        assert!(
            f.repo
                .join("target/debug/deps/libserde-0123456789abcdef.rlib")
                .is_file(),
            "removing the worktree deleted the artifact its links pointed at"
        );
    }

    /// The fallback refuses rather than guesses. A manifest that names no
    /// package leaves no way to tell a local artifact from a vendored one, and
    /// linking the wrong one is the failure this whole design exists to avoid.
    ///
    /// macOS never reaches this path: `clonefile` clones the whole tree before
    /// package names are asked, and a CoW clone does not need them.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn build_output_is_left_alone_when_the_packages_cannot_be_identified() {
        let f = Fixture::new();
        // The project asks for the cargo profile, and the manifest is not
        // enough for it to learn a single package name.
        share_target(&f);
        fs::write(f.repo.join("Cargo.toml"), "[workspace]\nresolver = \"2\"\n").unwrap();
        let debug = f.repo.join("target/debug/deps");
        fs::create_dir_all(&debug).unwrap();
        fs::write(debug.join("libserde-0123456789abcdef.rlib"), "serde\n").unwrap();

        assert!(
            artifact_policy(&f.repo).iter().any(|e| e.cargo_workspace),
            "the policy should have asked for the cargo profile"
        );

        let w = scratch("no-packages");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        assert!(
            !w.join("target").exists(),
            "target was provisioned without knowing which packages are local"
        );
    }

    /// Detection is what decides a project gets anything at all. A repository
    /// with no manifest of any kind is left exactly as it was.
    #[test]
    fn a_project_with_nothing_to_detect_shares_nothing() {
        let f = Fixture::new();
        assert!(artifact_policy(&f.repo).is_empty());
    }

    #[test]
    fn detection_covers_each_ecosystem_it_claims() {
        let f = Fixture::new();
        let named = |repo: &Path| -> Vec<String> {
            artifact_policy(repo).into_iter().map(|e| e.dir).collect()
        };

        fs::write(f.repo.join("package.json"), "{}").unwrap();
        assert!(named(&f.repo).contains(&"node_modules".to_string()));

        fs::write(f.repo.join("pyproject.toml"), "").unwrap();
        assert!(named(&f.repo).contains(&".venv".to_string()));

        fs::write(f.repo.join("go.mod"), "module x\n").unwrap();
        assert!(named(&f.repo).contains(&"vendor".to_string()));

        fs::write(f.repo.join("build.gradle"), "").unwrap();
        assert!(named(&f.repo).contains(&".gradle".to_string()));

        // Only Rust asks for the per-file treatment; everything else is one
        // link over an install directory.
        let modes: Vec<ShareMode> = artifact_policy(&f.repo).iter().map(|e| e.mode).collect();
        assert!(modes.iter().all(|m| *m == ShareMode::Link));
    }

    /// Detection stops at install directories. A Rust project gets nothing,
    /// because sharing `target` costs a hard link per file — around 42,000 of
    /// them here — in front of a launch the user is waiting on, and it buys a
    /// `cargo build` only for a thread that builds.
    #[test]
    fn detection_leaves_build_output_to_the_project() {
        let f = Fixture::new();
        fs::write(
            f.repo.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/demo-core\"]\n",
        )
        .unwrap();
        fs::create_dir_all(f.repo.join("target/debug")).unwrap();

        assert!(
            artifact_policy(&f.repo).is_empty(),
            "detection asked for build output"
        );

        // Still reachable, by saying so. This is the whole escape hatch: a
        // machine with reflinks, or output small enough for the walk to be
        // free, writes the file and gets the old behaviour back.
        share_target(&f);
        let asked = artifact_policy(&f.repo);
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0].dir, "target");
        assert_eq!(asked[0].mode, ShareMode::Hardlink);
    }

    /// The project's own file wins over detection, which is what makes an
    /// ecosystem nobody here can test serviceable.
    #[test]
    fn the_policy_file_replaces_detection() {
        let f = Fixture::new();
        fs::write(f.repo.join("Cargo.toml"), "[workspace]\nmembers = []\n").unwrap();
        fs::create_dir_all(f.repo.join(".boite")).unwrap();
        fs::write(
            f.repo.join(POLICY_FILE),
            r#"{"shared":[{"dir":"_build","mode":"hardlink","exclude":["dev/lib/mine/**"]}]}"#,
        )
        .unwrap();

        let policy = artifact_policy(&f.repo);
        assert_eq!(policy.len(), 1, "detection ran anyway");
        assert_eq!(policy[0].dir, "_build");
        assert_eq!(policy[0].mode, ShareMode::Hardlink);
        assert!(!policy[0].cargo_workspace);
        assert_eq!(policy[0].exclude, vec!["dev/lib/mine/**".to_string()]);
    }

    /// A file someone wrote by hand and got wrong must not silently fall back
    /// to detection: provisioning the thing they were trying to prevent is the
    /// worst available outcome.
    #[test]
    fn a_malformed_policy_file_shares_nothing() {
        let f = Fixture::new();
        fs::write(f.repo.join("Cargo.toml"), "[workspace]\nmembers = []\n").unwrap();
        fs::create_dir_all(f.repo.join(".boite")).unwrap();
        fs::write(f.repo.join(POLICY_FILE), "{ this is not json").unwrap();
        assert!(artifact_policy(&f.repo).is_empty());
    }

    /// The two sources are not interchangeable and the caller cannot tell them
    /// apart from the entries alone: an agent that mistakes detection for a
    /// declared rule overwrites a decision someone made about their own build.
    #[test]
    fn the_effective_policy_says_whether_anyone_declared_it() {
        let f = Fixture::new();
        fs::write(f.repo.join("package.json"), "{}").unwrap();

        let detected = effective_artifact_policy(&f.repo);
        assert!(!detected.declared);
        assert_eq!(detected.shared.len(), 1);

        write_artifact_policy(
            &f.repo,
            &ArtifactPolicy {
                shared: vec![link("vendor")],
            },
        )
        .unwrap();

        let declared = effective_artifact_policy(&f.repo);
        assert!(declared.declared);
        assert_eq!(declared.shared[0].dir, "vendor");
    }

    /// A file that fails to parse must not read as detection. Detection does not
    /// run behind it, so reporting `detected` would send the reader looking for
    /// a bug in the manifest sniffing instead of at the file they broke.
    #[test]
    fn a_malformed_policy_file_still_counts_as_declared() {
        let f = Fixture::new();
        fs::create_dir_all(f.repo.join(".boite")).unwrap();
        fs::write(f.repo.join(POLICY_FILE), "{ this is not json").unwrap();

        let policy = effective_artifact_policy(&f.repo);
        assert!(policy.declared);
        assert!(policy.shared.is_empty());
    }

    /// What is written has to be what is read back, or an agent tunes a policy
    /// against a file the provisioner understands differently.
    #[test]
    fn a_written_policy_reads_back_as_it_was_written() {
        let f = Fixture::new();
        let entry = SharedDir {
            dir: "_build".to_string(),
            mode: ShareMode::Hardlink,
            exclude: vec!["dev/lib/mine/**".to_string()],
            cargo_workspace: false,
        };
        write_artifact_policy(
            &f.repo,
            &ArtifactPolicy {
                shared: vec![entry],
            },
        )
        .unwrap();

        // The directory did not exist: creating it is the writer's job, not the
        // caller's, and forgetting it is how the first call to this ever fails.
        assert!(f.repo.join(POLICY_FILE).is_file());
        let back = artifact_policy(&f.repo);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].dir, "_build");
        assert_eq!(back[0].mode, ShareMode::Hardlink);
        assert_eq!(back[0].exclude, vec!["dev/lib/mine/**".to_string()]);
    }

    /// The provisioner skips a name like these in silence, so a policy holding
    /// one shares nothing and says nothing. Refusing at write time is what turns
    /// that into an error its author can read.
    #[test]
    fn a_policy_naming_anything_but_a_plain_directory_is_refused() {
        let f = Fixture::new();
        let refused = |dir: &str| {
            write_artifact_policy(
                &f.repo,
                &ArtifactPolicy {
                    shared: vec![link(dir)],
                },
            )
            .is_err()
        };
        assert!(refused(""));
        assert!(refused(".."));
        assert!(refused("../elsewhere"));
        assert!(refused("build/output"));
        // A backslash is only a separator on Windows, and the file travels.
        assert!(refused("build\\output"));
        assert!(refused("/etc"));
        assert!(refused("C:\\Windows"));

        assert!(!f.repo.join(POLICY_FILE).exists(), "a refused policy was written anyway");
    }

    /// `Link` is one junction for the whole directory, so declaring it for build
    /// output puts two worktrees back on one artifact slot, which is the exact
    /// corruption the per-file mode exists to prevent. The flags that say "a
    /// build rewrites part of this" are ignored under `Link`, so the pair only
    /// ever reads as a mistake.
    #[test]
    fn a_policy_cannot_share_build_output_with_a_whole_directory_link() {
        let f = Fixture::new();
        fs::write(f.repo.join("Cargo.toml"), "[workspace]\nmembers = []\n").unwrap();

        let write = |entry: SharedDir| {
            write_artifact_policy(
                &f.repo,
                &ArtifactPolicy {
                    shared: vec![entry],
                },
            )
        };

        assert!(write(link("target")).is_err(), "cargo's target was linkable");
        assert!(
            write(SharedDir {
                dir: "_build".to_string(),
                mode: ShareMode::Link,
                exclude: vec!["dev/**".to_string()],
                cargo_workspace: false,
            })
            .is_err(),
            "exclusions were accepted under a mode that ignores them"
        );
        assert!(
            write(SharedDir {
                dir: "_build".to_string(),
                mode: ShareMode::Link,
                exclude: Vec::new(),
                cargo_workspace: true,
            })
            .is_err(),
            "the cargo rule was accepted under a mode that ignores it"
        );

        // The same directory under the mode that handles build output is fine,
        // and so is a link to anything an install writes.
        assert!(write(SharedDir {
            dir: "target".to_string(),
            mode: ShareMode::Hardlink,
            exclude: Vec::new(),
            cargo_workspace: true,
        })
        .is_ok());
        assert!(write(link("node_modules")).is_ok());
    }

    /// The static list is a fallback, not the rule. A project that declared a
    /// directory of its own gets a link to it, and a link left in place is what
    /// git follows into the main checkout.
    #[test]
    fn unlinking_covers_a_directory_the_policy_declared() {
        let f = Fixture::new();
        write_artifact_policy(
            &f.repo,
            &ArtifactPolicy {
                shared: vec![link("deno_dir")],
            },
        )
        .unwrap();
        fs::create_dir_all(f.repo.join("deno_dir")).unwrap();
        fs::write(f.repo.join("deno_dir/keep.txt"), "mine\n").unwrap();

        let worktree = scratch("declared-link");
        fs::create_dir_all(&worktree).unwrap();
        let dst = worktree.join("deno_dir");
        if link_dir(&f.repo.join("deno_dir"), &dst).is_err() {
            // No junction or symlink on this machine, so there is nothing this
            // test can prove. It never fails for a reason of its own.
            let _ = fs::remove_dir_all(&worktree);
            return;
        }

        unlink_shared_artifacts(&f.repo, &worktree);

        assert!(
            fs::symlink_metadata(&dst).is_err(),
            "a declared directory's link survived and would be handed to git"
        );
        assert!(
            f.repo.join("deno_dir/keep.txt").is_file(),
            "unlinking followed the link and took the target with it"
        );
        let _ = fs::remove_dir_all(&worktree);
    }

    /// Renaming a claimed spare is allowed to fail. What must not happen is the
    /// sweep reading the leftover pool name as "nobody owns this" and removing a
    /// checkout a thread is sitting in.
    #[test]
    fn the_orphan_sweep_leaves_a_claimed_directory_alone() {
        let f = Fixture::new();
        let base = scratch("claimed-base");
        fs::create_dir_all(&base).unwrap();

        let claimed = base.join(format!("{SPARE_PREFIX}kept"));
        let leaked = base.join(format!("{SPARE_PREFIX}gone"));
        for dir in [&claimed, &leaked] {
            add_detached_worktree_blocking(f.path(), dir.to_str().unwrap()).unwrap();
        }
        mark_claimed(&claimed);

        // A day later, so age alone would collect both.
        sweep_orphan_spares(&base, &f.repo, now_secs() + 24 * 60 * 60);

        assert!(claimed.is_dir(), "the sweep removed a directory a thread was handed");
        assert!(!leaked.is_dir(), "the sweep stopped collecting what nobody owns");

        let _ = remove_worktree_blocking(f.path(), claimed.to_str().unwrap(), true);
        assert!(
            !is_claimed(&claimed),
            "the claim marker outlived the directory it names"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn exclusion_globs_stop_at_a_separator_unless_doubled() {
        assert!(glob_matches("cache/**", "cache/a/b/c.js"));
        assert!(glob_matches("cache/**", "cache"));
        assert!(glob_matches("*.tsbuildinfo", "app.tsbuildinfo"));
        assert!(glob_matches("dev/lib/*/ebin", "dev/lib/mine/ebin"));
        assert!(!glob_matches("dev/lib/*/ebin", "dev/lib/mine/deep/ebin"));
        assert!(!glob_matches("cache/*", "other/a"));
        assert!(glob_matches("**/*.pdb", "debug/deps/thing.pdb"));
    }

    /// The end of a pattern is an anchor. It read as one and checked nothing:
    /// the guard was `pattern.ends_with(tail)`, where `tail` is the pattern's
    /// own last segment, so it was true by construction for every pattern that
    /// does not end in `*`. Anything sharing a prefix with the pattern matched,
    /// which for a build-artifact exclusion means excluding files nobody named.
    #[test]
    fn a_glob_anchors_at_the_end_of_the_name() {
        assert!(!glob_matches("*.tsbuildinfo", "app.tsbuildinfo.bak"));
        assert!(!glob_matches("*.pdb", "thing.pdb.tmp"));
        assert!(!glob_matches("cache/*.js", "cache/a.js.map"));
        // The trailing literal is matched from the right, so a name that
        // repeats it still matches: `*` takes `a.js`.
        assert!(glob_matches("*.js", "a.js.js"));
        // A pattern with no star is a literal, not a prefix.
        assert!(glob_matches("target", "target"));
        assert!(!glob_matches("target", "targetting"));
        // Anchors that would have to overlap do not both hold.
        assert!(!glob_matches("ab*ba", "aba"));
        assert!(glob_matches("ab*ba", "abba"));
    }

    /// A policy with globs and no cargo rule is the generic path: everything is
    /// linked except what the author named.
    #[test]
    fn a_glob_only_policy_excludes_exactly_what_it_names() {
        let entry = SharedDir {
            dir: "_build".to_string(),
            mode: ShareMode::Hardlink,
            exclude: vec!["dev/lib/mine/**".to_string()],
            cargo_workspace: false,
        };
        let empty = HashSet::new();
        let mutable = |p: &str| is_mutable_build_artifact(Path::new(p), false, &entry, &empty);
        assert!(mutable("dev/lib/mine/ebin/a.beam"));
        assert!(!mutable("dev/lib/theirs/ebin/a.beam"));
        // Without the cargo rule, none of cargo's structure applies.
        assert!(!mutable("debug/whatever.exe"));
    }

    #[test]
    fn workspace_members_are_read_from_the_manifest() {
        let f = Fixture::new();
        with_cargo_target(&f);
        let names = workspace_package_names(&f.repo);
        assert!(names.contains("demo-core"), "hyphenated spelling missing");
        assert!(names.contains("demo_core"), "underscored spelling missing");
    }

    #[test]
    fn only_the_rewritten_artifacts_count_as_mutable() {
        let locals: HashSet<String> =
            ["demo-core", "demo_core"].iter().map(|s| s.to_string()).collect();
        let cargo = SharedDir {
            dir: "target".to_string(),
            mode: ShareMode::Hardlink,
            exclude: Vec::new(),
            cargo_workspace: true,
        };
        let file = |p: &str| is_mutable_build_artifact(Path::new(p), false, &cargo, &locals);
        let dir = |p: &str| is_mutable_build_artifact(Path::new(p), true, &cargo, &locals);

        // Uplifted finals, locks, and anything incremental.
        assert!(file("debug/demo.exe"));
        assert!(file("debug/.cargo-lock"));
        assert!(file("debug/incremental/demo-core-1.bin"));
        // This repository's own packages, in every spelling.
        assert!(file("debug/deps/libdemo_core-fedcba9876543210.rlib"));
        assert!(dir("debug/.fingerprint/demo-core-fedcba9876543210"));
        assert!(dir("debug/build/demo-core-fedcba9876543210"));
        // Everything fetched, which is the bulk of the tree.
        assert!(!file("debug/deps/libserde-0123456789abcdef.rlib"));
        assert!(!dir("debug/.fingerprint/serde-0123456789abcdef"));
        assert!(!file("debug/build/libc-0123456789abcdef/out/probe.o"));
        // The directories that hold all of it are not themselves artifacts.
        assert!(!dir("debug/deps"));
        assert!(!dir("debug/build"));
        assert!(!dir("debug/.fingerprint"));
    }

    /// `demo` is a prefix of `demo-core`, and a package named for the prefix
    /// must not claim the other's artifacts. The hash suffix is what separates
    /// them, so it is checked rather than assumed.
    #[test]
    fn a_shorter_package_name_does_not_claim_a_longer_ones_artifacts() {
        let locals: HashSet<String> = ["demo"].iter().map(|s| s.to_string()).collect();
        assert!(is_local_artifact("demo-0123456789abcdef.d", &locals));
        assert!(!is_local_artifact("demo-core-0123456789abcdef.d", &locals));
    }

    /// The nested layout only works if the main checkout stays clean. This is
    /// the assertion the old "worktrees live outside the project" rule existed
    /// to guarantee, now guaranteed a different way.
    #[test]
    fn a_worktree_inside_the_project_leaves_the_checkout_clean() {
        let f = Fixture::new();
        let base = worktree_base_for(&f.repo);
        assert_eq!(base, f.repo.join(".boite").join("worktrees"));

        let w = scoped_dir_for(&base, "thread-1");
        fs::create_dir_all(&base).unwrap();
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        assert!(w.join("a.txt").is_file(), "the worktree was not checked out");

        let mut status = git(&f.repo);
        status.args(["status", "--porcelain", "--untracked-files=normal"]);
        let out = run(status).unwrap();
        assert!(
            out.is_empty(),
            "the nested worktree made the main checkout dirty: {}",
            String::from_utf8_lossy(&out)
        );

        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
    }

    #[test]
    fn the_exclude_rule_is_written_once_and_only_once() {
        let f = Fixture::new();
        ensure_boite_excluded(&f.repo);
        ensure_boite_excluded(&f.repo);
        ensure_boite_excluded(&f.repo);
        let text = fs::read_to_string(f.repo.join(".git/info/exclude")).unwrap();
        for rule in [".boite/", ".grok/"] {
            assert_eq!(
                text.lines().filter(|l| l.trim() == rule).count(),
                1,
                "{rule} was appended more than once"
            );
        }
    }

    /// The config Boite itself writes for grok must not be what stops Boite
    /// from cleaning up after itself: an unexcluded `.grok/` reads as untracked,
    /// which reads as dirty, which refuses the unforced remove that closing a
    /// thread asks for, and the worktree stays on the disk forever.
    #[test]
    fn a_worktree_carrying_grok_config_is_still_removable_unforced() {
        let f = Fixture::new();
        let base = worktree_base_for(&f.repo);
        let w = scoped_dir_for(&base, "thread-grok");
        fs::create_dir_all(&base).unwrap();
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        fs::create_dir_all(w.join(GROK_DIR)).unwrap();
        fs::write(w.join(GROK_DIR).join("config.toml"), "[mcp_servers.boite]\n").unwrap();

        remove_worktree_blocking(f.path(), w.to_str().unwrap(), false)
            .expect("the worktree Boite wrote into refused its own cleanup");
        assert!(!w.exists(), "the worktree was left on the disk");
    }

    /// The migration exists to carry work across, so the test is about the
    /// work: a modification nobody committed, a commit on no branch, and git
    /// still knowing where the worktree went.
    #[test]
    fn migrating_a_worktree_carries_its_work_into_the_project() {
        let f = Fixture::new();
        // The policy is what makes a directory disposable. Without one, output
        // found in the worktree is just a directory nobody can prove is
        // reproducible, and it gets carried across like anything else.
        share_target(&f);
        fs::write(
            f.repo.join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        git_in(&f.repo, &["add", "Cargo.toml"]);
        git_in(&f.repo, &["commit", "--quiet", "-m", "manifest"]);
        let legacy = scratch("legacy-base");
        fs::create_dir_all(&legacy).unwrap();
        let old = scoped_dir_for(&legacy, "thread-9");
        add_detached_worktree_blocking(f.path(), old.to_str().unwrap()).unwrap();

        fs::write(old.join("kept.txt"), "committed here\n").unwrap();
        git_in(&old, &["add", "kept.txt"]);
        git_in(&old, &["commit", "--quiet", "-m", "on no branch"]);
        fs::write(old.join("a.txt"), "uncommitted\n").unwrap();
        // Provisioned output, which must be dropped rather than carried.
        fs::create_dir_all(old.join("target/debug")).unwrap();
        fs::write(old.join("target/debug/app"), "stale\n").unwrap();
        // A directory the policy does not name is none of this code's business,
        // however much it looks like build output.
        fs::create_dir_all(old.join("dist")).unwrap();
        fs::write(old.join("dist/theirs.txt"), "mine\n").unwrap();

        let new = scoped_dir_for(&worktree_base_for(&f.repo), "thread-9");
        let landed =
            migrate_worktree_blocking(f.path(), old.to_str().unwrap(), new.to_str().unwrap())
                .unwrap();
        assert_eq!(landed.as_deref(), Some(new.to_str().unwrap()));

        assert!(!old.exists(), "the old worktree is still on disk");
        assert!(new.join("kept.txt").is_file(), "the commit's file did not survive");
        assert_eq!(
            fs::read_to_string(new.join("a.txt")).unwrap(),
            "uncommitted\n",
            "the uncommitted change did not survive"
        );
        assert!(
            !new.join("target/debug/app").exists(),
            "stale build output was carried across instead of dropped"
        );
        assert_eq!(
            fs::read_to_string(new.join("dist/theirs.txt")).unwrap(),
            "mine\n",
            "a directory the policy never named was deleted"
        );

        let entries = list_worktrees_blocking(f.path()).unwrap();
        let moved = entries.iter().find(|e| !e.main).expect("git lost the worktree");
        assert_eq!(
            fs::canonicalize(&moved.path).unwrap(),
            fs::canonicalize(&new).unwrap(),
            "git still points at the old path"
        );
        assert!(moved.orphan_commits, "the commit on no branch was lost");

        let _ = remove_worktree_blocking(f.path(), new.to_str().unwrap(), true);
        let _ = fs::remove_dir_all(&legacy);
    }

    #[test]
    fn migration_refuses_to_overwrite_and_reports_a_missing_source_as_gone() {
        let f = Fixture::new();
        let here = scratch("occupied");
        fs::create_dir_all(&here).unwrap();
        // Absolute and never created. A path with no root at all is a different
        // refusal — it would resolve against whatever directory the process
        // happens to be in — and `/nowhere` is one of those on Windows, where a
        // path without a drive is relative to the current one.
        let nowhere = scratch("nowhere-at-all");
        assert_eq!(
            migrate_worktree_blocking(f.path(), nowhere.to_str().unwrap(), here.to_str().unwrap()),
            Ok(None),
            "a source that is not there has to read as gone, not as a failure"
        );

        let legacy = scratch("legacy-2");
        let old = scoped_dir_for(&legacy, "t");
        fs::create_dir_all(&old).unwrap();
        assert!(
            migrate_worktree_blocking(f.path(), old.to_str().unwrap(), here.to_str().unwrap())
                .is_err(),
            "an existing destination was overwritten"
        );

        let _ = fs::remove_dir_all(&here);
        let _ = fs::remove_dir_all(&legacy);
    }

    #[cfg(not(windows))]
    #[test]
    fn a_case_changed_sibling_is_not_under_the_migration_base() {
        let base = scratch("classify-case-base");
        fs::create_dir_all(&base).unwrap();
        let sibling = base.with_file_name(
            base.file_name()
                .unwrap()
                .to_string_lossy()
                .to_uppercase(),
        );

        assert_eq!(
            classify_migration_source(&base, &sibling.join("thread-1")),
            Ok(MigrationSource::Elsewhere),
            "a case-sensitive sibling was classified as inside the base"
        );

        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn migration_path_comparisons_remain_case_insensitive_on_windows() {
        let base = scratch("classify-case-base");
        fs::create_dir_all(&base).unwrap();
        let other_case = PathBuf::from(base.to_string_lossy().to_uppercase());

        assert!(
            same_dir(&base, &other_case),
            "Windows spellings of one directory compared as different"
        );
        assert_eq!(
            classify_migration_source(&base, &other_case.join("thread-1")),
            Ok(MigrationSource::Legacy),
            "a Windows path under the base was classified as elsewhere"
        );

        let _ = fs::remove_dir_all(&base);
    }

    /// The source of a migration is the one path in this domain that arrives
    /// from a caller and is never checked against the registered roots, so its
    /// shape is the whole boundary. Everything the front door has to refuse
    /// before it hands the path to something that unlinks, deletes and renames.
    #[test]
    fn a_migration_source_is_one_directory_directly_under_the_base() {
        let base = scratch("classify-base");
        fs::create_dir_all(&base).unwrap();

        // The base holds every thread's worktree. Moving it moves all of them,
        // and `git worktree repair` is then pointed at a directory full of
        // directories.
        assert!(
            classify_migration_source(&base, &base).is_err(),
            "the base itself was accepted as a worktree"
        );

        // `Path::starts_with` compares components without resolving them, so
        // this one reads as inside the base and lands anywhere on the disk.
        let out = base.join("..").join("anything");
        assert!(
            classify_migration_source(&base, &out).is_err(),
            "a source climbing out of the base with `..` was accepted"
        );
        assert!(
            classify_migration_source(&base, Path::new("relative/enough")).is_err(),
            "a relative source was accepted, and it resolves against whatever the process's cwd is"
        );

        // One level down and no further: the check is what makes the name the
        // whole of the path.
        assert!(
            classify_migration_source(&base, &base.join("thread").join("deeper")).is_err(),
            "a source two levels under the base was accepted"
        );

        // Not ours, and not an error either: the caller asked whether an old
        // worktree needs carrying across, and the answer is no.
        let elsewhere = scratch("classify-elsewhere");
        assert_eq!(
            classify_migration_source(&base, &elsewhere.join("t")),
            Ok(MigrationSource::Elsewhere),
            "a path under nobody's base has to read as nothing to do"
        );

        // A junction wearing a worktree's name. `is_dir` follows it, `rename`
        // moves the link, and the sweep of provisioned directories deletes
        // inside whatever it points at.
        let target = scratch("classify-target");
        fs::create_dir_all(&target).unwrap();
        // A junction on Windows and a symlink everywhere else, which is what
        // the provisioner writes: neither needs elevation, so this is a real
        // assertion rather than one that quietly skips.
        let link = base.join("linked");
        super::super::artifacts::link_dir(&target, &link).unwrap();
        assert!(
            classify_migration_source(&base, &link).is_err(),
            "a link in the base was accepted as the directory it points at"
        );

        let real = base.join("thread-1");
        fs::create_dir_all(&real).unwrap();
        assert_eq!(
            classify_migration_source(&base, &real),
            Ok(MigrationSource::Legacy),
            "the shape every migration has was refused"
        );

        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&target);
    }

    /// The same refusals again, at the other end.
    ///
    /// The front door knows which base an earlier release left behind and this
    /// does not; what this knows is which repository a directory belongs to.
    /// Neither check is the other's, and the mutation is on this side, so what
    /// matters in each case is that the directory named is still there
    /// afterwards.
    #[test]
    fn migration_refuses_anything_that_is_not_this_repository_s_worktree() {
        let f = Fixture::new();
        let base = scratch("guard-base");
        fs::create_dir_all(&base).unwrap();
        let to = scoped_dir_for(&worktree_base_for(&f.repo), "thread-1");

        // Somebody's files, beside the base rather than under it, reached the
        // old way: `<base>/../victim`.
        let victim = base.parent().unwrap().join(format!(
            "{}-victim",
            base.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir_all(victim.join("node_modules")).unwrap();
        fs::write(victim.join("node_modules").join("theirs.txt"), "mine\n").unwrap();
        let traversal = base
            .join("..")
            .join(victim.file_name().unwrap())
            .to_string_lossy()
            .into_owned();
        assert!(
            migrate_worktree_blocking(f.path(), &traversal, to.to_str().unwrap()).is_err(),
            "a source with `..` in it was moved"
        );
        assert!(
            victim.join("node_modules").join("theirs.txt").is_file(),
            "a directory outside the base was swept by a migration"
        );

        // The right place, the right shape, and not a checkout at all.
        let plain = base.join("thread-2");
        fs::create_dir_all(plain.join("target")).unwrap();
        fs::write(plain.join("target").join("keep.txt"), "mine\n").unwrap();
        assert!(
            migrate_worktree_blocking(f.path(), plain.to_str().unwrap(), to.to_str().unwrap())
                .is_err(),
            "a directory that is not a worktree was moved"
        );
        assert!(
            plain.join("target").join("keep.txt").is_file(),
            "a directory that is not a worktree had its build output swept"
        );

        // A worktree, of somebody else's repository.
        let other = Fixture::new();
        let theirs = base.join("thread-3");
        add_detached_worktree_blocking(other.path(), theirs.to_str().unwrap()).unwrap();
        assert!(
            migrate_worktree_blocking(f.path(), theirs.to_str().unwrap(), to.to_str().unwrap())
                .is_err(),
            "another repository's worktree was migrated into this one"
        );
        assert!(theirs.join("a.txt").is_file(), "another repository's worktree was moved");

        // A junction, which `is_dir` cannot tell from the directory it names.
        let target = scratch("guard-target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("theirs.txt"), "mine\n").unwrap();
        let link = base.join("thread-4");
        super::super::artifacts::link_dir(&target, &link).unwrap();
        assert!(
            migrate_worktree_blocking(f.path(), link.to_str().unwrap(), to.to_str().unwrap())
                .is_err(),
            "a link was migrated as though it were the directory it points at"
        );
        assert!(
            target.join("theirs.txt").is_file(),
            "the directory a link pointed at was emptied"
        );

        // And the one that still has to work, plus the one that still has to
        // read as nothing left to move rather than as a failure.
        let mine = base.join("thread-5");
        add_detached_worktree_blocking(f.path(), mine.to_str().unwrap()).unwrap();
        assert_eq!(
            migrate_worktree_blocking(f.path(), mine.to_str().unwrap(), to.to_str().unwrap()),
            Ok(Some(to.to_string_lossy().into_owned())),
            "a worktree of this repository, one level under a base, was refused"
        );
        assert!(to.join("a.txt").is_file(), "the migration carried nothing across");
        assert_eq!(
            migrate_worktree_blocking(f.path(), mine.to_str().unwrap(), to.to_str().unwrap()),
            Ok(None),
            "a source that is no longer there has to read as gone"
        );

        let _ = remove_worktree_blocking(f.path(), to.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(other.path(), theirs.to_str().unwrap(), true);
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&victim);
        let _ = fs::remove_dir_all(&target);
    }

    #[test]
    fn unlinking_never_touches_a_real_directory() {
        let dir = scratch("real");
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules/keep.txt"), "mine\n").unwrap();

        unlink_shared_artifacts(&dir, &dir);

        assert!(dir.join("node_modules/keep.txt").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reserving_moves_a_worktree_onto_an_existing_branch() {
        let f = Fixture::new();
        git_in(&f.repo, &["branch", "feat/started-earlier"]);
        let w = scratch("reserve");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();

        reserve_worktree_branch_blocking(w.to_str().unwrap(), "feat/started-earlier").unwrap();
        assert_eq!(symbolic_branch(&w).as_deref(), Some("feat/started-earlier"));

        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
    }

    /// The message has to name the holder: "already checked out" with no
    /// location is the least actionable git error there is.
    #[test]
    fn reserving_a_branch_another_worktree_holds_says_where_it_is() {
        let f = Fixture::new();
        let a = scratch("holder");
        let b = scratch("wants-it");
        add_detached_worktree_blocking(f.path(), a.to_str().unwrap()).unwrap();
        add_detached_worktree_blocking(f.path(), b.to_str().unwrap()).unwrap();
        claim_worktree_branch_blocking(a.to_str().unwrap(), "feat/taken").unwrap();

        let err = reserve_worktree_branch_blocking(b.to_str().unwrap(), "feat/taken").unwrap_err();
        assert!(err.contains("feat/taken"), "{err}");
        assert!(err.contains("already checked out"), "{err}");
        assert!(symbolic_branch(&b).is_none(), "b stayed detached");

        // The branch the main checkout is on is held too, and by the same rule.
        let err = reserve_worktree_branch_blocking(b.to_str().unwrap(), "master").unwrap_err();
        assert!(err.contains("already checked out"), "{err}");

        let _ = remove_worktree_blocking(f.path(), a.to_str().unwrap(), true);
        let _ = remove_worktree_blocking(f.path(), b.to_str().unwrap(), true);
    }

    #[test]
    fn reserving_refuses_a_branch_that_does_not_exist() {
        let f = Fixture::new();
        let w = scratch("missing");
        add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).unwrap();
        let err = reserve_worktree_branch_blocking(w.to_str().unwrap(), "feat/never").unwrap_err();
        assert!(err.contains("no local branch"), "{err}");
        let _ = remove_worktree_blocking(f.path(), w.to_str().unwrap(), true);
    }

    #[test]
    fn an_id_cannot_climb_out_of_its_base() {
        let base = Path::new("/data/worktrees");
        assert_eq!(scoped_dir_for(base, "../../etc"), base.join("------etc"));
        assert_eq!(scoped_dir_for(base, "th_1-2"), base.join("th_1-2"));
        // Whatever it is given, the result stays one level under the base.
        for id in ["", "..", "/abs", "C:\\win", "a/b"] {
            let p = scoped_dir_for(base, id);
            assert_eq!(p.parent(), Some(base), "{id} escaped to {p:?}");
        }
    }

    #[test]
    fn adding_refuses_a_path_that_is_already_there() {
        let f = Fixture::new();
        let w = scratch("taken");
        fs::create_dir_all(&w).unwrap();
        assert!(add_detached_worktree_blocking(f.path(), w.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&w);
    }
}

