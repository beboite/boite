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
//! Two shapes cover every vendor (see [`catalog::Shape`]): one executable, bare
//! or inside an archive, and a tree that has to stay together. Eight of the ten
//! CLIs come down that way, one goes through the package manager it ships on,
//! and the last keeps its doc link.
//!
//! **A vendor's installer being a shell script is not the same as a vendor
//! having no artifact.** Most of these scripts do what this module does — read a
//! manifest, take a URL, check a digest — and doing it here instead means it
//! works the same on Windows, where a bash installer does not run at all and two
//! vendors' scripts refuse to try. What is left is Pi, which is a Node package
//! with no native build, and Hermes, whose installer clones a repository and
//! puts a Python runtime beside it; there is no artifact there to name or check.

pub mod archive;
pub mod catalog;
pub mod install;
pub mod jobs;
pub mod net;
pub mod purge;

use std::path::PathBuf;

use catalog::{Algo, Checksum, Cli, Download, Platform, Presence, Shape, Source, Version};
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
    /// A complete copy the vendor's own installer left behind, when the
    /// executable resolves nowhere. `Some` here with `installed: false` is a
    /// broken install rather than an absent one, and the two read very
    /// differently to somebody who remembers installing it.
    pub unlinked: Option<String>,
    pub version: Option<String>,
    /// `download`, `managed` or `manual`, which is what the row's buttons follow.
    pub source: &'static str,
    pub installable: bool,
    /// For a `managed` source: the command that has to be there first, whether it
    /// is, and where to get it when it is not.
    pub requires: Option<&'static str>,
    pub requires_present: Option<bool>,
    pub requires_url: Option<&'static str>,
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
        let (
            requires,
            requires_present,
            requires_url,
            install_command,
            update_command,
            uninstall_command,
        ) = match &cli.source {
            Source::Managed {
                requires,
                requires_url,
                install,
                update,
                uninstall,
            } => (
                Some(*requires),
                Some(crate::shell::command_exists(requires)),
                Some(*requires_url),
                Some(install.to_vec()),
                Some(update.to_vec()),
                Some(uninstall.to_vec()),
            ),
            Source::Download(_) | Source::Manual => (None, None, None, None, None, None),
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
            unlinked: (!installed)
                .then(|| catalog::vendor_install(cli.id))
                .flatten()
                .map(|p| p.to_string_lossy().into_owned()),
            version: None,
            source: match cli.source {
                Source::Download(_) => "download",
                Source::Managed { .. } => "managed",
                Source::Manual => "manual",
            },
            installable: cli.installable(),
            requires,
            requires_present,
            requires_url,
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

/// The version inside whatever a `--version` printed.
///
/// The first token that looks like one, not the last token on the line: they are
/// the same thing for `codex-cli 0.148.0` and different for
/// `2.1.235 (Claude Code)`, which is what claude prints and which read as the
/// version "Code)" for as long as this took the last one.
fn parse_version(text: &str) -> Option<String> {
    let line = text.lines().find(|line| !line.trim().is_empty())?;
    let looks_like_one = |token: &str| {
        let token = token.trim_start_matches('v');
        let mut parts = token.split('.');
        parts.next().is_some_and(|first| {
            !first.is_empty() && first.chars().all(|c| c.is_ascii_digit())
        }) && token.contains('.')
    };
    let found = line
        .split_whitespace()
        .map(|token| token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-'))
        .find(|token| looks_like_one(token))
        // A tool that prints something else entirely still gets to answer with the
        // last word rather than with nothing, which is what the plugins panel has
        // always done.
        .or_else(|| line.split_whitespace().last())?;
    let found = found.trim_start_matches('v').trim();
    (!found.is_empty()).then(|| found.to_string())
}

/// What `<exe> <arg>` says, or `None` when it says nothing usable.
///
/// Absence is an answer rather than an error: the panel draws a row either way.
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
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

/// What the vendor publishes right now, for one CLI Boite downloads.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub id: String,
    /// The current version, or `None` when asking did not get an answer.
    pub version: Option<String>,
    /// Why it could not be asked. Carried rather than swallowed: "you are up to
    /// date" and "nobody could tell you" are different rows, and a panel that
    /// draws the first for the second is the reason this exists.
    pub error: Option<String>,
}

/// What every downloadable CLI's vendor currently publishes.
///
/// **Separate from [`status_blocking`] on purpose.** Presence is read off this
/// machine and answers in milliseconds; this one is a request per vendor over
/// somebody else's network, and folding it in would make opening the panel wait
/// on six web servers. So the panel draws the rows first and asks this second.
///
/// Only a `download` source is here. A package manager's idea of what is current
/// is its own to answer, and running it to find out is the update itself.
pub fn latest_blocking() -> Vec<Latest> {
    let mut probes = Vec::new();
    for cli in catalog::CLIS {
        let Source::Download(download) = cli.source else {
            continue;
        };
        // No build for this machine is not a failure to report: the row already
        // says the button is off, and an error under it would say it twice.
        let Some(platform) = download.platform() else {
            continue;
        };
        probes.push((
            cli.id,
            std::thread::spawn(move || match resolve(&download, platform) {
                Ok(resolved) => (Some(resolved.version), None),
                Err(Failed(why)) => (None, Some(why)),
            }),
        ));
    }
    probes
        .into_iter()
        .map(|(id, probe)| {
            let (version, error) = probe.join().unwrap_or_else(|_| {
                (None, Some("the check stopped without an answer".to_string()))
            });
            Latest {
                id: id.to_string(),
                version,
                error,
            }
        })
        .collect()
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
    // Asked before the download rather than after it: with no home directory there
    // is nowhere to install, and finding that out is not worth three hundred
    // megabytes.
    if install::bin_dir().is_none() {
        return Err(Failed(
            "no home directory on this machine, so there is nowhere to install into".to_string(),
        ));
    }

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
    /// The digest the same answer carried, for the vendor that publishes one
    /// alongside the URL rather than in a manifest of its own.
    digest: Option<(Algo, String)>,
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
                digest: None,
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
                digest: None,
            })
        }
        Version::GithubLatest { repo } => {
            let listing =
                net::json(&format!("https://api.github.com/repos/{repo}/releases/latest"))?;
            pick_asset(&listing, platform, repo)
        }
        Version::PlatformManifest { digest } => {
            read_manifest(&net::json(platform.artifact)?, platform, digest)
        }
        Version::Channel { url, digest } => {
            let channel = net::json(url)?;
            let version = sane_version(json_string(&channel, &["version"], "the channel")?)?;
            let manifest_url = https_url(
                json_string(&channel, &["manifest_url"], "the channel")?,
                "the channel",
            )?;
            read_channel(&net::json(&manifest_url)?, platform, digest, version)
        }
        Version::NpmPlatformPackage { root } => resolve_npm(root, platform),
    }
}

/// One string out of a vendor's JSON, or a refusal naming what was missing.
///
/// A field that went missing is what a vendor changing shape looks like from
/// here, and it has to read as that rather than as an empty string carried into
/// a URL.
fn json_string<'a>(
    document: &'a serde_json::Value,
    keys: &[&str],
    what: &str,
) -> Result<&'a str, Failed> {
    let mut node = document;
    for key in keys {
        node = node
            .get(key)
            .ok_or_else(|| Failed(format!("{what} names no {key}")))?;
    }
    node.as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            Failed(format!(
                "{what} answered nothing for {}",
                keys.last().copied().unwrap_or("it")
            ))
        })
}

/// A URL a vendor wrote and this process is about to fetch.
///
/// Held to https rather than trusted. Everywhere the artifact URL comes out of a
/// document instead of out of this catalogue, the digest beside it is the only
/// thing saying the bytes are the vendor's — and a document that came back over a
/// hijacked connection naming an `http://` or a `file://` would be the way past it.
fn https_url(url: &str, what: &str) -> Result<String, Failed> {
    if !url.starts_with("https://") {
        return Err(Failed(format!(
            "{what} points somewhere that is not https"
        )));
    }
    Ok(url.to_string())
}

/// A published digest, lowercased and checked to be hex.
fn hex_digest(raw: &str, algo: Algo, what: &str) -> Result<(Algo, String), Failed> {
    let hex = raw.trim().to_ascii_lowercase();
    if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Failed(format!(
            "{what} carries a {} that is not hex",
            algo.field()
        )));
    }
    Ok((algo, hex))
}

/// The version, URL and digest one per-platform manifest carries.
///
/// Separate from the fetch so the parsing is testable without a network, the same
/// way [`pick_asset`] is.
fn read_manifest(
    manifest: &serde_json::Value,
    platform: &Platform,
    algo: Algo,
) -> Result<Resolved, Failed> {
    let what = format!("the manifest for {}", platform.plat);
    let version = sane_version(json_string(manifest, &["version"], &what)?)?;
    let url = https_url(json_string(manifest, &["url"], &what)?, &what)?;
    // A manifest that stopped carrying a digest is not a reason to install
    // without one: the check going missing is exactly the failure it exists for.
    let digest = hex_digest(json_string(manifest, &[algo.field()], &what)?, algo, &what)?;
    Ok(Resolved {
        version,
        url,
        digest: Some(digest),
    })
}

/// This platform's artifact out of a manifest that names every platform.
///
/// The file name is checked against the URL rather than taken on trust. It is the
/// one thing this can verify about a manifest it did not write: a platform key
/// that started pointing at another platform's build would otherwise install a
/// binary that cannot run here, with a digest that matches it perfectly.
fn read_channel(
    manifest: &serde_json::Value,
    platform: &Platform,
    algo: Algo,
    version: String,
) -> Result<Resolved, Failed> {
    let what = format!("the manifest for {}", platform.plat);
    let url = https_url(
        json_string(manifest, &["artifacts", platform.plat, "url"], &what)?,
        &what,
    )?;
    if !url.contains(platform.artifact) {
        return Err(Failed(format!(
            "{what} points at something other than {}",
            platform.artifact
        )));
    }
    let digest = hex_digest(
        json_string(manifest, &["artifacts", platform.plat, "checksum"], &what)?,
        algo,
        &what,
    )?;
    Ok(Resolved {
        version,
        url,
        digest: Some(digest),
    })
}

/// What npm publishes for this platform, in the two requests npm itself makes.
///
/// The root package names the version and pins one package per platform; that
/// package names its tarball and the digest. The pin is read rather than the root
/// version reused, because a platform the vendor stopped building for loses its
/// pin — and asking for a version that was never published is a 404 the user
/// would read as "the network is down".
fn resolve_npm(root: &'static str, platform: &Platform) -> Result<Resolved, Failed> {
    let root_document = net::json(&format!("https://registry.npmjs.org/{root}/latest"))?;
    let version = sane_version(json_string(&root_document, &["version"], root)?)?;
    let pinned = sane_version(json_string(
        &root_document,
        &["optionalDependencies", platform.artifact],
        &format!("{root}, for {}", platform.plat),
    )?)?;

    let package = net::json(&format!(
        "https://registry.npmjs.org/{}/{pinned}",
        platform.artifact
    ))?;
    let what = format!("{} {pinned}", platform.artifact);
    let url = https_url(json_string(&package, &["dist", "tarball"], &what)?, &what)?;
    let digest = npm_integrity(json_string(&package, &["dist", "integrity"], &what)?, &what)?;
    // The version shown is the product's, not the platform package's. They are
    // the same number today, and the one the user reads back out of
    // `copilot --version` is the product's.
    Ok(Resolved {
        version,
        url,
        digest: Some(digest),
    })
}

/// npm's `dist.integrity`, which is `<algorithm>-<base64>` rather than hex.
fn npm_integrity(raw: &str, what: &str) -> Result<(Algo, String), Failed> {
    use base64::Engine as _;

    let (name, encoded) = raw
        .trim()
        .split_once('-')
        .ok_or_else(|| Failed(format!("{what} carries an integrity that names no algorithm")))?;
    let algo = match name {
        "sha512" => Algo::Sha512,
        "sha256" => Algo::Sha256,
        // sha1 is also legal there and is not a check worth making. Refusing is
        // the honest answer: this installs nothing it cannot verify.
        other => {
            return Err(Failed(format!(
                "{what} is published with {other}, which is not a digest this checks"
            )))
        }
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| Failed(format!("{what} carries an integrity that is not base64: {e}")))?;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    hex_digest(&hex, algo, what)
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
    let asset = assets
        .iter()
        .find(|asset| asset.get("name").and_then(|v| v.as_str()) == Some(platform.artifact))
        .ok_or_else(|| {
            Failed(format!(
                "{repo} {tag} publishes no {}, so this platform has nothing to install",
                platform.artifact
            ))
        })?;
    let url = json_string(asset, &["browser_download_url"], &format!("{repo} {tag}"))?;
    // GitHub hashes every asset it stores and hands the digest back with the
    // listing, so these two came down unverified for no reason other than nobody
    // having read the field. `None` where an older release predates it, which is
    // the same install these had before.
    let digest = match asset.get("digest").and_then(|value| value.as_str()) {
        Some(published) => Some(github_digest(published, &format!("{repo} {tag}"))?),
        None => None,
    };
    Ok(Resolved {
        version,
        url: url.to_string(),
        digest,
    })
}

/// GitHub's asset digest, which is `<algorithm>:<hex>`.
fn github_digest(raw: &str, what: &str) -> Result<(Algo, String), Failed> {
    let (name, hex) = raw
        .trim()
        .split_once(':')
        .ok_or_else(|| Failed(format!("{what} publishes a digest that names no algorithm")))?;
    let algo = match name {
        "sha256" => Algo::Sha256,
        "sha512" => Algo::Sha512,
        other => {
            return Err(Failed(format!(
                "{what} publishes a {other} digest, which is not one this checks"
            )))
        }
    };
    hex_digest(hex, algo, what)
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

    // The digest the resolve already carried wins: a vendor that publishes it
    // beside the URL has answered, and a second lookup could only disagree.
    let expected = match &resolved.digest {
        Some((algo, hex)) => Some((*algo, hex.clone())),
        None => published_checksum(&download.checksum, platform, &resolved.version)?
            .map(|hex| (Algo::Sha256, hex)),
    };
    let scratch = Scratch::new(id)?;
    let artifact = scratch.0.join(artifact_name(&resolved.url, cli));

    jobs::phase(id, Phase::Downloading);
    net::download(&resolved.url, &artifact, cancel, |received, total| {
        jobs::progress(id, received, total)
    })?;
    cancelled(cancel)?;

    if let Some((algo, expected)) = expected {
        jobs::phase(id, Phase::Verifying);
        let actual = net::digest(&artifact, algo)?;
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
        // The artifact's own name decides whether there is anything to unpack:
        // one vendor ships a bare `.exe` on Windows and a tarball everywhere
        // else, and reading it here is what keeps that from being declared twice.
        Shape::Executable { inner } => match archive::kind_of(&resolved.url) {
            Err(_) => {
                jobs::phase(id, Phase::Installing);
                install::place_binary(&artifact, &name)?;
            }
            Ok(kind) => {
                jobs::phase(id, Phase::Unpacking);
                let unpacked = scratch.0.join("unpacked");
                archive::extract(&artifact, kind, &unpacked, 0)?;
                let binary = archive::find_binary(&unpacked, inner.unwrap_or(cli.exe))?;
                cancelled(cancel)?;
                jobs::phase(id, Phase::Installing);
                install::place_binary(&binary, &name)?;
            }
        },
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

    /// Every shape these ten actually print, and the one that broke it.
    #[test]
    fn the_version_is_the_number_and_not_the_last_word() {
        // What claude prints. Reading the last token answered "Code)".
        assert_eq!(parse_version("2.1.235 (Claude Code)").unwrap(), "2.1.235");
        assert_eq!(parse_version("1.18.18
").unwrap(), "1.18.18");
        assert_eq!(parse_version("codex-cli 0.148.0").unwrap(), "0.148.0");
        assert_eq!(parse_version("grok v1.0.5").unwrap(), "1.0.5");
        assert_eq!(
            parse_version("cursor-agent 2026.08.11-e8db854").unwrap(),
            "2026.08.11-e8db854"
        );
        assert_eq!(parse_version("

  1.2.3  
").unwrap(), "1.2.3");
        // Nothing that looks like a version: the last word beats no answer, which
        // is what the plugins panel has always done.
        assert_eq!(parse_version("version unknown").unwrap(), "unknown");
        assert_eq!(parse_version("   
"), None);
        assert_eq!(parse_version(""), None);
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

    /// The three things a per-platform manifest has to answer, and the four ways
    /// it can be wrong.
    ///
    /// Pinned because this is the one artifact URL the catalogue does not spell
    /// out: the vendor writes it, this process fetches it, and the digest beside
    /// it is the only thing that says the bytes are the vendor's. A manifest that
    /// dropped a field, or that names something other than https, has to be a
    /// refusal rather than an install without a check.
    #[test]
    fn a_manifest_answers_all_three_or_none() {
        let platform = Platform {
            os: catalog::Os::Linux,
            arch: catalog::Arch::X64,
            plat: "linux_amd64",
            artifact: "https://example.test/manifests/linux_amd64.json",
        };
        let read = |json: &str| {
            read_manifest(
                &serde_json::from_str(json).unwrap(),
                &platform,
                Algo::Sha512,
            )
        };

        let good = read(
            r#"{"version":"1.1.15","url":"https://example.test/1.1.15-53503/linux-x64/cli.tar.gz","sha512":"AB12"}"#,
        )
        .unwrap();
        assert_eq!(good.version, "1.1.15");
        assert_eq!(
            good.url,
            "https://example.test/1.1.15-53503/linux-x64/cli.tar.gz"
        );
        // Lowercased here so the comparison against what was hashed is one rule
        // rather than two spellings of it.
        assert_eq!(good.digest, Some((Algo::Sha512, "ab12".to_string())));

        assert!(read(r#"{"url":"https://example.test/cli","sha512":"ab"}"#).is_err());
        assert!(read(r#"{"version":"1.0","sha512":"ab"}"#).is_err());
        // A manifest that stopped carrying a digest installs nothing: the check
        // going missing is the failure it exists for.
        assert!(read(r#"{"version":"1.0","url":"https://example.test/cli"}"#).is_err());
        assert!(read(r#"{"version":"1.0","url":"http://example.test/cli","sha512":"ab"}"#).is_err());
        assert!(read(r#"{"version":"1.0","url":"https://example.test/cli","sha512":"zz"}"#).is_err());
        assert!(read(r#"{"version":"../../etc","url":"https://example.test/cli","sha512":"ab"}"#).is_err());
    }

    /// One platform's artifact out of a manifest that names them all, and the
    /// check that it is this platform's.
    ///
    /// The file-name check is the only thing this can verify about a document it
    /// did not write. A platform key that started pointing at another platform's
    /// build would otherwise install a binary that cannot run here, carrying a
    /// digest that matches it perfectly.
    #[test]
    fn a_channel_manifest_gives_this_platform_and_not_a_neighbour() {
        let platform = Platform {
            os: catalog::Os::Windows,
            arch: catalog::Arch::X64,
            plat: "x86_windows",
            artifact: "muse-x86-windows.exe",
        };
        let read = |json: &str| {
            read_channel(
                &serde_json::from_str(json).unwrap(),
                &platform,
                Algo::Sha256,
                "0.2.1-R1215.1".to_string(),
            )
        };

        let good = read(
            r#"{"artifacts":{"x86_windows":{"url":"https://example.test/d/?file=muse-x86-windows.exe","checksum":"D51F"},
                             "x86_linux":{"url":"https://example.test/d/?file=muse-x86-linux","checksum":"BFD8"}}}"#,
        )
        .unwrap();
        assert_eq!(good.version, "0.2.1-R1215.1");
        assert_eq!(good.digest, Some((Algo::Sha256, "d51f".to_string())));

        // The linux build filed under the windows key.
        assert!(read(
            r#"{"artifacts":{"x86_windows":{"url":"https://example.test/d/?file=muse-x86-linux","checksum":"BFD8"}}}"#
        )
        .is_err());
        // A platform the vendor stopped building for.
        assert!(read(r#"{"artifacts":{"x86_linux":{"url":"https://example.test/d/?file=muse-x86-linux","checksum":"BF"}}}"#).is_err());
        assert!(read(r#"{"artifacts":{"x86_windows":{"url":"https://example.test/d/?file=muse-x86-windows.exe"}}}"#).is_err());
        assert!(read(r#"{"artifacts":{"x86_windows":{"url":"http://example.test/d/?file=muse-x86-windows.exe","checksum":"D51F"}}}"#).is_err());
    }

    /// The two digest spellings this reads, and the refusals around them.
    ///
    /// npm writes `<algorithm>-<base64>` and GitHub writes `<algorithm>:<hex>`,
    /// and both end up compared against the same lowercase hex. An algorithm
    /// neither hasher covers is a refusal rather than an install that skips the
    /// check, which is the one way an unverified binary could still get through.
    #[test]
    fn a_published_digest_is_read_in_whichever_way_it_was_written() {
        // The sha512 npm published for `@github/copilot-linux-x64` 1.0.80, whose
        // hex was read off the tarball it names.
        let (algo, hex) = npm_integrity(
            "sha512-qv1ytVNwA3IDK7kcQow+fAikD67t42+AQ8X42bK/7oudNiv4frVZMO0yh1DYIebVRcmEhmPvbVPY/ptVUK3cbA==",
            "a package",
        )
        .unwrap();
        assert_eq!(algo, Algo::Sha512);
        assert!(hex.starts_with("aafd72b553700372"), "{hex}");
        assert_eq!(hex.len(), 128);

        assert_eq!(
            github_digest("sha256:A3F0", "a release").unwrap(),
            (Algo::Sha256, "a3f0".to_string())
        );

        assert!(npm_integrity("sha1-YWJj", "a package").is_err());
        assert!(npm_integrity("qv1ytVNwA3ID", "a package").is_err());
        assert!(npm_integrity("sha512-not base64!", "a package").is_err());
        assert!(github_digest("md5:abcd", "a release").is_err());
        assert!(github_digest("abcd", "a release").is_err());
        assert!(github_digest("sha256:zzzz", "a release").is_err());
    }

    /// Only what the panel is told is installable may start a job, and the
    /// refusals say which of the two reasons it was.
    #[test]
    fn a_cli_boite_does_not_download_refuses_to_start() {
        // Pi, whose package is Node and has no native build to fetch. Never a
        // download-source id: this call starts a real job, and asserting on the
        // refusal is only safe where there is nothing to refuse to.
        let err = start_install("pi").unwrap_err();
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
