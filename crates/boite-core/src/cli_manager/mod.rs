//! Installing and removing the agent CLIs, on the machine the agents run on.
//!
//! Boite knew whether a CLI was there and nothing else, so the answer to "it is
//! not there" was a documentation link. This module is the other half: it fetches
//! the vendor's own binary, puts it in a directory Boite owns, and takes it back
//! out again — optionally with the CLI's own data, which is the one part of an
//! uninstall nobody can undo and therefore the part with the rules
//! ([`purge`]).
//!
//! **It lives in `boite-core` so both hosts have it.** A desktop and a
//! `boite-server` install onto the machine the threads spawn on, which is the
//! same machine `shell::command_exists` already answers for; written in the
//! webview it would install onto a phone.
//!
//! **It is deliberately not on the MCP endpoint.** Every other capability the
//! user has, an agent gets too. Not this one: installing a binary and deleting
//! `~/.claude` are not things a terminal's agent should be able to do on the
//! user's behalf, and a tool call that could is a tool call that will.
//!
//! Three shapes cover every vendor (see [`catalog::Shape`]): a bare binary, an
//! archive holding one, and a tree that has to stay together. Four of the ten
//! CLIs come down that way, one goes through the package manager it ships on, and
//! the rest keep their doc link, because an install line nobody verified fetches
//! the wrong package.

pub mod archive;
pub mod catalog;
pub mod install;
pub mod jobs;
pub mod net;
pub mod purge;

use std::path::PathBuf;

use catalog::{Checksum, Cli, Download, Platform, Presence, Shape, Source, Version};
pub use jobs::{Kind, Phase, Snapshot};
pub use purge::DataPath;

/// Why a job stopped. One type, so `?` works from the socket to the file system.
#[derive(Debug, Clone)]
pub struct Failed(pub String);

/// The message a cancelled job carries instead of an error, and the only string
/// [`jobs::settle`] reads rather than reports.
pub const CANCELLED: &str = "cancelled by the user";

/// The home directory every path in this module is resolved against and checked
/// against.
///
/// `dirs::home_dir`, like the rest of the crate, with one addition: the tests
/// point `BOITE_CLI_HOME` at a directory of their own. A purge test that read the
/// real home would delete the developer's own `~/.claude`, and a test that can do
/// that once can do it on somebody else's machine.
pub fn home_dir() -> Option<PathBuf> {
    if let Some(over) = std::env::var_os("BOITE_CLI_HOME") {
        if !over.is_empty() {
            return Some(PathBuf::from(over));
        }
    }
    dirs::home_dir()
}

/// Whether the home above is a test's rather than the user's.
pub(crate) fn home_overridden() -> bool {
    std::env::var_os("BOITE_CLI_HOME").is_some_and(|value| !value.is_empty())
}

/// One CLI, as the settings panel draws it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    /// The executable presence is decided on.
    pub exe: String,
    pub installed: bool,
    /// Where it resolved, for the row's tooltip. `None` when it is absent.
    pub path: Option<String>,
    /// Whether that path is inside Boite's own bin, which is what decides whether
    /// an uninstall is Boite's to do or the user's package manager's.
    pub managed: bool,
    pub version: Option<String>,
    /// `download`, `managed` or `manual`, which is what the row's buttons follow.
    pub source: &'static str,
    pub installable: bool,
    /// For a `managed` source: the command that has to be there first, and
    /// whether it is.
    pub requires: Option<&'static str>,
    pub requires_present: Option<bool>,
    /// The three command lines a `managed` source runs in a terminal, argv-style,
    /// so the webview holds no package names of its own.
    pub install_command: Option<Vec<&'static str>>,
    pub update_command: Option<Vec<&'static str>>,
    pub uninstall_command: Option<Vec<&'static str>>,
    /// The CLI's data directories that exist right now. Paths only: their size is
    /// a directory walk, and the uninstall dialogue is the only thing that needs
    /// it ([`data_paths`]).
    pub data_paths: Vec<String>,
}

/// Every CLI, with what this machine says about it.
///
/// `probe_versions` costs one process spawn per installed CLI, run in parallel:
/// the panel asks for it when it opens and leaves it off when it is only
/// refreshing presence after an install.
pub fn status_blocking(probe_versions: bool) -> Vec<Status> {
    install::sweep_retired();
    let mut rows: Vec<Status> = Vec::with_capacity(catalog::CLIS.len());
    let mut probes = Vec::new();
    for cli in catalog::CLIS {
        let resolved = crate::shell::resolve_command(cli.exe);
        let managed = resolved.as_deref().map(install::is_managed).unwrap_or(false);
        // An extension is not its host tool. `gh` resolving says gh is installed;
        // whether the agent is takes asking gh.
        let installed = resolved.is_some()
            && match cli.presence {
                Presence::Exe => true,
                Presence::Listed { argv, needle } => listed(argv, needle),
            };
        let (requires, requires_present, install_command, update_command, uninstall_command) =
            match &cli.source {
                Source::Managed {
                    requires,
                    install,
                    update,
                    uninstall,
                } => (
                    Some(*requires),
                    Some(crate::shell::command_exists(requires)),
                    Some(install.to_vec()),
                    Some(update.to_vec()),
                    Some(uninstall.to_vec()),
                ),
                Source::Download(_) | Source::Manual => (None, None, None, None, None),
            };
        if probe_versions && installed {
            if let Some(arg) = cli.version_arg {
                let exe = cli.exe.to_string();
                let arg = arg.to_string();
                let id = cli.id.to_string();
                probes.push(std::thread::spawn(move || (id, probe_version(&exe, &arg))));
            }
        }
        rows.push(Status {
            id: cli.id.to_string(),
            exe: cli.exe.to_string(),
            installed,
            path: resolved.map(|p| p.to_string_lossy().into_owned()),
            managed,
            version: None,
            source: match cli.source {
                Source::Download(_) => "download",
                Source::Managed { .. } => "managed",
                Source::Manual => "manual",
            },
            installable: cli.installable(),
            requires,
            requires_present,
            install_command,
            update_command,
            uninstall_command,
            data_paths: purge::paths(cli)
                .into_iter()
                .filter(|path| std::fs::symlink_metadata(path).is_ok())
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        });
    }
    for probe in probes {
        // A probe that panicked is a probe that answered nothing, which is the
        // same row a CLI with no `--version` draws.
        if let Ok((id, version)) = probe.join() {
            if let Some(row) = rows.iter_mut().find(|row| row.id == id) {
                row.version = version;
            }
        }
    }
    rows
}

/// Whether `argv` prints `needle`, which is how an extension answers for itself.
///
/// A failure to run it is an absence rather than an error: the row it draws is
/// the same one a tool that is not installed draws.
fn listed(argv: &[&str], needle: &str) -> bool {
    use std::process::{Command, Stdio};

    let Some((exe, args)) = argv.split_first() else {
        return false;
    };
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(out) = cmd.output() else {
        return false;
    };
    out.status.success() && String::from_utf8_lossy(&out.stdout).contains(needle)
}

/// What `<exe> <arg>` says, or `None` when it says nothing usable.
///
/// The last whitespace-separated token, which is the convention every one of
/// these follows (`claude 2.1.227`, `codex-cli 0.148.0`). Absence is an answer
/// rather than an error: the panel draws a row either way.
fn probe_version(exe: &str, arg: &str) -> Option<String> {
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(exe);
    cmd.stdin(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.arg(arg).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let version = text
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .trim()
        .to_string();
    (!version.is_empty()).then_some(version)
}

/// The data directories of one CLI with their sizes, for the uninstall dialogue.
pub fn data_paths(id: &str) -> Result<Vec<DataPath>, Failed> {
    let cli = catalog::find(id).ok_or_else(|| Failed(format!("no CLI named {id}")))?;
    Ok(purge::preview(cli))
}

/// Starts an install and answers at once with the job that is now running.
///
/// The call returns in milliseconds and the work takes minutes, so the thread is
/// detached and the panel reads [`jobs`]. Only a `download` source is Boite's to
/// run: a package manager's install goes through a terminal the user can read,
/// which is the machinery the plugins panel already has.
pub fn start_install(id: &str) -> Result<Snapshot, Failed> {
    let cli = catalog::find(id).ok_or_else(|| Failed(format!("no CLI named {id}")))?;
    let Source::Download(download) = cli.source else {
        return Err(Failed(format!(
            "{id} is not Boite's to download; it installs through its own package manager"
        )));
    };
    let platform = download.platform().ok_or_else(|| {
        Failed(format!(
            "{id} has no build for this platform, so there is nothing to download"
        ))
    })?;

    let cancel = jobs::start(id, Kind::Install)?;
    let owned = id.to_string();
    std::thread::Builder::new()
        .name(format!("boite-cli-install-{id}"))
        .spawn(move || {
            let outcome = run_install(cli, &download, platform, &cancel);
            jobs::settle(&owned, outcome);
        })
        .map_err(|e| {
            jobs::settle(id, Err(Failed(format!("no thread to install on: {e}"))));
            Failed(format!("no thread to install on: {e}"))
        })?;
    snapshot_of(id)
}

/// Starts an uninstall: the managed binary, and the CLI's own data when asked.
///
/// Removing nothing is not a failure. A CLI the user installed themselves has no
/// managed binary to take back, and saying so beats refusing a purge the user
/// asked for in the same breath.
pub fn start_uninstall(id: &str, purge_data: bool) -> Result<Snapshot, Failed> {
    let cli = catalog::find(id).ok_or_else(|| Failed(format!("no CLI named {id}")))?;
    let cancel = jobs::start(id, Kind::Uninstall)?;
    let owned = id.to_string();
    std::thread::Builder::new()
        .name(format!("boite-cli-uninstall-{id}"))
        .spawn(move || {
            let outcome = run_uninstall(cli, purge_data, &cancel);
            jobs::settle(&owned, outcome);
        })
        .map_err(|e| {
            jobs::settle(id, Err(Failed(format!("no thread to remove on: {e}"))));
            Failed(format!("no thread to remove on: {e}"))
        })?;
    snapshot_of(id)
}

fn snapshot_of(id: &str) -> Result<Snapshot, Failed> {
    jobs::all()
        .into_iter()
        .find(|snapshot| snapshot.id == id)
        .ok_or_else(|| Failed(format!("the job for {id} went missing as it started")))
}

/// The version, and where the artifact for this machine is.
#[derive(Debug)]
struct Resolved {
    version: String,
    url: String,
}

/// A version is substituted into a URL and into a directory name, so it is
/// checked before either.
///
/// `../../` in a version read off a vendor's page would otherwise be a path
/// somewhere else on the disk and a URL to somewhere else on the internet.
fn sane_version(raw: &str) -> Result<String, Failed> {
    let version = raw.trim().lines().next().unwrap_or_default().trim();
    let sane = !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'));
    if !sane {
        return Err(Failed(format!(
            "the vendor answered something that is not a version: {:?}",
            version.chars().take(40).collect::<String>()
        )));
    }
    Ok(version.to_string())
}

fn resolve(download: &Download, platform: &Platform) -> Result<Resolved, Failed> {
    match download.version {
        Version::Text(url) => {
            let version = sane_version(&net::text(url)?)?;
            Ok(Resolved {
                url: platform.artifact.replace("{version}", &version),
                version,
            })
        }
        Version::Script { url, needle } => {
            let body = net::text(url)?;
            let start = body
                .find(needle)
                .ok_or_else(|| Failed(format!("{url} no longer says where the build is")))?
                + needle.len();
            let rest = &body[start..];
            let end = rest.find('/').unwrap_or(rest.len());
            let version = sane_version(&rest[..end])?;
            Ok(Resolved {
                url: platform.artifact.replace("{version}", &version),
                version,
            })
        }
        Version::GithubLatest { repo } => {
            let listing =
                net::json(&format!("https://api.github.com/repos/{repo}/releases/latest"))?;
            pick_asset(&listing, platform, repo)
        }
    }
}

/// The version and URL a GitHub release listing gives this platform.
///
/// Separate from the fetch so the choice is testable without a network: which
/// asset a platform takes is the part that goes wrong when a vendor renames one,
/// and a release carrying twenty assets for four tools has plenty of near misses
/// (`codex-x86_64-…`, `codex-app-server-x86_64-…`). The name is matched whole,
/// never by prefix.
fn pick_asset(listing: &serde_json::Value, platform: &Platform, repo: &str) -> Result<Resolved, Failed> {
    let tag = listing
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Failed(format!("{repo} published a release with no tag")))?;
    // The tag is the vendor's to shape (`rust-v0.148.0`), and only the number is
    // shown. A tag that is not a version at all is carried through as it is
    // rather than refused: it is a label here, not a path or a URL.
    let version = sane_version(tag.trim_start_matches(|c: char| !c.is_ascii_digit()))
        .unwrap_or_else(|_| tag.to_string());
    let assets = listing
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| Failed(format!("{repo}'s latest release has no assets")))?;
    let url = assets
        .iter()
        .find(|asset| asset.get("name").and_then(|v| v.as_str()) == Some(platform.artifact))
        .and_then(|asset| asset.get("browser_download_url"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            Failed(format!(
                "{repo} {tag} publishes no {}, so this platform has nothing to install",
                platform.artifact
            ))
        })?;
    Ok(Resolved {
        version,
        url: url.to_string(),
    })
}

/// The sha256 the vendor published for this platform, when it published one.
fn published_checksum(
    checksum: &Option<Checksum>,
    platform: &Platform,
    version: &str,
) -> Result<Option<String>, Failed> {
    let Some(Checksum::Manifest { url }) = checksum else {
        return Ok(None);
    };
    let manifest = net::json(&url.replace("{version}", version))?;
    let digest = manifest
        .get("platforms")
        .and_then(|platforms| platforms.get(platform.plat))
        .and_then(|entry| entry.get("checksum"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_ascii_lowercase());
    // A manifest that exists and does not name this platform is a manifest that
    // changed shape, and installing unverified because the check went missing is
    // the failure this exists to prevent.
    digest
        .map(Some)
        .ok_or_else(|| Failed(format!("the vendor's manifest names no {}", platform.plat)))
}

fn cancelled(cancel: &std::sync::atomic::AtomicBool) -> Result<(), Failed> {
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(Failed(CANCELLED.to_string()));
    }
    Ok(())
}

/// A directory of this job's own, removed whatever happens.
struct Scratch(PathBuf);

impl Scratch {
    fn new(id: &str) -> Result<Self, Failed> {
        let dir = std::env::temp_dir().join(format!(
            "boite-cli-{id}-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        std::fs::create_dir_all(&dir)
            .map_err(|e| Failed(format!("cannot make {}: {e}", dir.display())))?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // A download of a few hundred megabytes left in the temp directory is the
        // other half of an install that failed, and nobody goes looking for it.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run_install(
    cli: &'static Cli,
    download: &Download,
    platform: &Platform,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Option<String>, Failed> {
    let id = cli.id;
    jobs::phase(id, Phase::Resolving);
    let resolved = resolve(download, platform)?;
    jobs::version(id, &resolved.version);
    cancelled(cancel)?;

    let expected = published_checksum(&download.checksum, platform, &resolved.version)?;
    let scratch = Scratch::new(id)?;
    let artifact = scratch.0.join(artifact_name(&resolved.url, cli));

    jobs::phase(id, Phase::Downloading);
    net::download(&resolved.url, &artifact, cancel, |received, total| {
        jobs::progress(id, received, total)
    })?;
    cancelled(cancel)?;

    if let Some(expected) = expected {
        jobs::phase(id, Phase::Verifying);
        let actual = net::sha256(&artifact)?;
        if actual != expected {
            return Err(Failed(format!(
                "the download does not match the digest the vendor published ({} rather than {})",
                &actual[..12.min(actual.len())],
                &expected[..12.min(expected.len())]
            )));
        }
    }
    cancelled(cancel)?;

    let name = cli.file_name();
    match download.shape {
        Shape::Binary => {
            jobs::phase(id, Phase::Installing);
            install::place_binary(&artifact, &name)?;
        }
        Shape::Archive => {
            jobs::phase(id, Phase::Unpacking);
            let kind = archive::kind_of(&resolved.url)?;
            let unpacked = scratch.0.join("unpacked");
            archive::extract(&artifact, kind, &unpacked, 0)?;
            let binary = archive::find_binary(&unpacked, cli.exe)?;
            cancelled(cancel)?;
            jobs::phase(id, Phase::Installing);
            install::place_binary(&binary, &name)?;
        }
        Shape::Package { entry } => {
            jobs::phase(id, Phase::Unpacking);
            let kind = archive::kind_of(&resolved.url)?;
            let package = install::prepare_package(id, &resolved.version)?;
            // One component stripped: this vendor wraps the tree in a directory
            // named after the build, and its own installer strips it too.
            archive::extract(&artifact, kind, &package, 1)?;
            cancelled(cancel)?;
            jobs::phase(id, Phase::Installing);
            install::link_package(&package, entry, &name)?;
        }
    }
    Ok(Some(resolved.version))
}

/// What the downloaded file is called on disk.
///
/// The last path segment of the URL, because the extension is what decides which
/// unpacker runs. A URL that ends in a slash or a query gets the executable's own
/// name, which is the bare-binary case.
fn artifact_name(url: &str, cli: &Cli) -> String {
    url.rsplit('/')
        .next()
        .map(|name| name.split(['?', '#']).next().unwrap_or(name))
        .filter(|name| !name.is_empty())
        .unwrap_or(cli.exe)
        .to_string()
}

fn run_uninstall(
    cli: &'static Cli,
    purge_data: bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<Option<String>, Failed> {
    let id = cli.id;
    jobs::phase(id, Phase::Removing);
    let removed = install::uninstall(id, &cli.file_name())?;
    cancelled(cancel)?;

    let mut purged = Vec::new();
    if purge_data {
        jobs::phase(id, Phase::Purging);
        purged = purge::purge(cli)?;
    }
    Ok(Some(match (removed, purged.len()) {
        (0, 0) => "nothing left to remove".to_string(),
        (_, 0) => "removed".to_string(),
        (_, count) => format!("removed, with {count} data directories"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_that_is_not_one_is_refused() {
        assert_eq!(sane_version("2.1.227\n").unwrap(), "2.1.227");
        assert_eq!(sane_version(" 1.0.5 ").unwrap(), "1.0.5");
        assert_eq!(
            sane_version("2026.08.11-e8db854").unwrap(),
            "2026.08.11-e8db854"
        );
        // The two that matter: a version read off a vendor's page is substituted
        // into a URL and into a directory name.
        assert!(sane_version("../../etc").is_err());
        assert!(sane_version("1.0 && rm -rf").is_err());
        assert!(sane_version("<!doctype html>").is_err());
        assert!(sane_version("").is_err());
    }

    #[test]
    fn the_artifact_keeps_the_extension_the_unpacker_reads() {
        let cli = catalog::find("codex").unwrap();
        assert_eq!(
            artifact_name(
                "https://example.test/codex-x86_64-unknown-linux-musl.tar.gz",
                cli
            ),
            "codex-x86_64-unknown-linux-musl.tar.gz"
        );
        let claude = catalog::find("claude").unwrap();
        assert_eq!(
            artifact_name("https://example.test/2.1.227/linux-x64/claude", claude),
            "claude"
        );
    }

    /// The asset a platform takes is matched whole. A release listing four tools
    /// under one tag is full of names this could reach for by mistake, and
    /// installing `codex-app-server` as `codex` would look like it worked.
    #[test]
    fn one_asset_is_chosen_out_of_a_release_that_ships_four_tools() {
        let listing = serde_json::json!({
            "tag_name": "rust-v0.148.0",
            "assets": [
                { "name": "codex-app-server-x86_64-unknown-linux-musl.tar.gz",
                  "browser_download_url": "https://example.test/app-server" },
                { "name": "codex-x86_64-unknown-linux-musl.zst",
                  "browser_download_url": "https://example.test/zst" },
                { "name": "codex-x86_64-unknown-linux-musl.tar.gz",
                  "browser_download_url": "https://example.test/codex" },
            ],
        });
        let platform = Platform {
            os: catalog::Os::Linux,
            arch: catalog::Arch::X64,
            plat: "x86_64-unknown-linux-musl",
            artifact: "codex-x86_64-unknown-linux-musl.tar.gz",
        };
        let picked = pick_asset(&listing, &platform, "openai/codex").unwrap();
        assert_eq!(picked.url, "https://example.test/codex");
        // The tag is the vendor's to shape; the row shows the number in it.
        assert_eq!(picked.version, "0.148.0");
    }

    /// A vendor that renamed an asset is a refusal naming what it looked for, not
    /// a download of whatever else was in the release.
    #[test]
    fn a_platform_with_no_asset_is_told_what_was_missing() {
        let listing = serde_json::json!({
            "tag_name": "v1.0.0",
            "assets": [{ "name": "opencode-linux-x64.tar.gz", "browser_download_url": "https://example.test/x" }],
        });
        let platform = Platform {
            os: catalog::Os::Windows,
            arch: catalog::Arch::Arm64,
            plat: "windows-arm64",
            artifact: "opencode-windows-arm64.zip",
        };
        let err = pick_asset(&listing, &platform, "sst/opencode").unwrap_err();
        assert!(err.0.contains("opencode-windows-arm64.zip"), "{}", err.0);
    }

    /// A manifest that no longer names this platform stops the install rather than
    /// letting it through unverified.
    #[test]
    fn a_missing_digest_is_a_refusal_and_not_a_shrug() {
        let platform = Platform {
            os: catalog::Os::Linux,
            arch: catalog::Arch::X64,
            plat: "linux-x64",
            artifact: "https://example.test/{version}/linux-x64/claude",
        };
        // No network in a unit test: the manifest URL is a file that does not
        // exist, so this asserts the shape of the failure rather than the fetch.
        let checksum = Some(Checksum::Manifest {
            url: "https://127.0.0.1:1/{version}/manifest.json",
        });
        assert!(published_checksum(&checksum, &platform, "1.0.0").is_err());
        assert!(published_checksum(&None, &platform, "1.0.0")
            .unwrap()
            .is_none());
    }

    /// Only what the panel is told is installable may start a job, and the
    /// refusals say which of the two reasons it was.
    #[test]
    fn a_cli_boite_does_not_download_refuses_to_start() {
        let err = start_install("copilot").unwrap_err();
        assert!(err.0.contains("package manager"), "{}", err.0);
        let err = start_install("nothing-like-that").unwrap_err();
        assert!(err.0.contains("no CLI named"), "{}", err.0);
    }

    /// The webview sends an id and gets a row per CLI back, in catalogue order,
    /// with no version probe asked for.
    #[test]
    fn the_status_listing_answers_for_every_cli() {
        let rows = status_blocking(false);
        assert_eq!(rows.len(), catalog::CLIS.len());
        for (row, cli) in rows.iter().zip(catalog::CLIS) {
            assert_eq!(row.id, cli.id);
            assert!(row.version.is_none(), "no probe was asked for");
            match cli.source {
                Source::Managed { .. } => assert!(row.install_command.is_some()),
                _ => assert!(row.install_command.is_none()),
            }
        }
    }
}
