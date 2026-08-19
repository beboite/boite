//! Which agent CLIs Boite can install, and where each one keeps its data.
//!
//! One table, in Rust, because three facts about the same ten tools used to live
//! in three unrelated places: the command line and the icon in
//! `settings/cliPresets.ts`, the install recipe nowhere at all, and the data
//! directories scattered through `session/`. The webview reads this table over
//! the bus rather than keeping a copy of its own, which is the rule the command
//! bus already follows: a fact written twice drifts, and the drift is what ships
//! broken.
//!
//! **Every artifact is spelled out per platform.** A template with `{os}` and
//! `{arch}` in it looks shorter and cannot be read against the vendor's own
//! release list, which is the only thing that can tell you it is wrong.
//! `{version}` is the one substitution, being the part nobody can pin.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Os {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Arch {
    X64,
    Arm64,
}

/// The machine this Boite runs on, or `None` on a platform no vendor builds for.
///
/// The host, never the device drawing the screen: a Windows desktop driving a
/// Linux boite installs Linux binaries, for the same reason
/// `shell.commandExists` answers for the host.
pub fn host_target() -> Option<(Os, Arch)> {
    let os = if cfg!(target_os = "windows") {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::Macos
    } else if cfg!(target_os = "linux") {
        Os::Linux
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "x86_64") {
        Arch::X64
    } else if cfg!(target_arch = "aarch64") {
        Arch::Arm64
    } else {
        return None;
    };
    Some((os, arch))
}

/// How the current version is found. Every vendor publishes it somewhere else.
#[derive(Debug, Clone, Copy)]
pub enum Version {
    /// A URL whose whole body is the version, one line of text.
    Text(&'static str),
    /// GitHub's latest release: the tag carries the version and the assets carry
    /// the URLs, so `Platform::artifact` is an asset *name* rather than a URL.
    GithubLatest { repo: &'static str },
    /// A version pinned inside the vendor's own shell installer, which is the
    /// only place this one publishes it. The needle is the literal in front of
    /// it, and the version runs from there to the next slash.
    Script {
        url: &'static str,
        needle: &'static str,
    },
}

/// What comes down the wire, and what has to end up in the managed bin.
#[derive(Debug, Clone, Copy)]
pub enum Shape {
    /// The download is the executable.
    Binary,
    /// An archive holding one executable, which is moved into the managed bin.
    Archive,
    /// A tree that has to stay together, a launcher beside its own runtime, so it
    /// is unpacked whole and `entry` is linked into the managed bin.
    Package { entry: &'static str },
}

/// Where a published sha256 can be read, when the vendor publishes one.
#[derive(Debug, Clone, Copy)]
pub enum Checksum {
    /// A JSON manifest keyed by the vendor's platform name, each entry carrying a
    /// `checksum` field. `{version}` is substituted.
    Manifest { url: &'static str },
}

#[derive(Debug, Clone, Copy)]
pub struct Platform {
    pub os: Os,
    pub arch: Arch,
    /// The vendor's own name for this platform, used to read a checksum manifest.
    pub plat: &'static str,
    /// A full URL, or a GitHub asset name for [`Version::GithubLatest`].
    pub artifact: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct Download {
    pub version: Version,
    pub shape: Shape,
    pub checksum: Option<Checksum>,
    /// One entry per platform the vendor builds for. A platform absent from this
    /// list is a platform where the button is off and the doc link is all there is.
    pub platforms: &'static [Platform],
}

/// How a CLI gets onto the machine.
#[derive(Debug, Clone, Copy)]
pub enum Source {
    /// Boite downloads it: no Node, no cargo, nothing but this process.
    Download(Download),
    /// A package manager the user already has does the work, in a PTY, because
    /// these tools ship no standalone binary. `requires` is the command that has
    /// to be there first, which the panel probes before offering the button, and
    /// `requires_url` is where the user goes to get it — a row that says "needs
    /// gh" and stops there leaves them to search for it themselves.
    Managed {
        requires: &'static str,
        requires_url: &'static str,
        install: &'static [&'static str],
        update: &'static [&'static str],
        uninstall: &'static [&'static str],
    },
    /// The vendor's instructions and nothing else. Not a gap to fill in later
    /// with a guess: an install line nobody verified is an install line that
    /// fetches the wrong package.
    Manual,
}

/// Which directory a data path hangs off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Base {
    Home,
    Config,
    Data,
    DataLocal,
}

/// A directory a CLI keeps its own state in.
///
/// Read off the code that already opens these stores (`session/`, `usage.rs`,
/// `commands/agents.rs`), so this is what Boite has been reading all along rather
/// than a guess about what a vendor writes. Some are shared with more than the
/// CLI — `~/.cursor` also holds the editor's MCP config — which is why the panel
/// lists every path and its size before anything is removed.
#[derive(Debug, Clone, Copy)]
pub struct DataDir {
    pub base: Base,
    pub path: &'static str,
}

/// How presence is decided.
///
/// For nine of the ten it is the executable resolving, which is what the rest of
/// Boite already asks. Copilot is a `gh` extension: `gh` resolving says the host
/// tool is there and nothing about the agent, and a row that read it as installed
/// offered an update that upgrades something nobody installed.
#[derive(Debug, Clone, Copy)]
pub enum Presence {
    Exe,
    Listed {
        argv: &'static [&'static str],
        needle: &'static str,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct Cli {
    /// The same id as the preset in the webview. A test asserts the two lists agree.
    pub id: &'static str,
    /// The executable a thread spawns, which is what presence is decided on.
    pub exe: &'static str,
    /// How this CLI is asked for its version, or `None` where the answer would be
    /// somebody else's version.
    pub version_arg: Option<&'static str>,
    pub presence: Presence,
    pub source: Source,
    pub data: &'static [DataDir],
}

macro_rules! claude_url {
    ($plat:literal, $bin:literal) => {
        concat!(
            "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/{version}/",
            $plat,
            "/",
            $bin
        )
    };
}

const CLAUDE: Download = Download {
    version: Version::Text(
        "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/stable",
    ),
    shape: Shape::Binary,
    checksum: Some(Checksum::Manifest {
        url: "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/{version}/manifest.json",
    }),
    platforms: &[
        Platform { os: Os::Windows, arch: Arch::X64, plat: "win32-x64", artifact: claude_url!("win32-x64", "claude.exe") },
        Platform { os: Os::Windows, arch: Arch::Arm64, plat: "win32-arm64", artifact: claude_url!("win32-arm64", "claude.exe") },
        Platform { os: Os::Macos, arch: Arch::Arm64, plat: "darwin-arm64", artifact: claude_url!("darwin-arm64", "claude") },
        Platform { os: Os::Macos, arch: Arch::X64, plat: "darwin-x64", artifact: claude_url!("darwin-x64", "claude") },
        Platform { os: Os::Linux, arch: Arch::X64, plat: "linux-x64", artifact: claude_url!("linux-x64", "claude") },
        Platform { os: Os::Linux, arch: Arch::Arm64, plat: "linux-arm64", artifact: claude_url!("linux-arm64", "claude") },
    ],
};

const GROK: Download = Download {
    version: Version::Text("https://x.ai/cli/stable"),
    shape: Shape::Binary,
    // The vendor's installer publishes no digest of its own, so HTTPS is the
    // whole story here, and the panel says as much.
    checksum: None,
    platforms: &[
        Platform { os: Os::Windows, arch: Arch::X64, plat: "windows-x86_64", artifact: "https://x.ai/cli/grok-{version}-windows-x86_64.exe" },
        Platform { os: Os::Windows, arch: Arch::Arm64, plat: "windows-aarch64", artifact: "https://x.ai/cli/grok-{version}-windows-aarch64.exe" },
        Platform { os: Os::Macos, arch: Arch::Arm64, plat: "macos-aarch64", artifact: "https://x.ai/cli/grok-{version}-macos-aarch64" },
        Platform { os: Os::Macos, arch: Arch::X64, plat: "macos-x86_64", artifact: "https://x.ai/cli/grok-{version}-macos-x86_64" },
        Platform { os: Os::Linux, arch: Arch::X64, plat: "linux-x86_64", artifact: "https://x.ai/cli/grok-{version}-linux-x86_64" },
        Platform { os: Os::Linux, arch: Arch::Arm64, plat: "linux-aarch64", artifact: "https://x.ai/cli/grok-{version}-linux-aarch64" },
    ],
};

const CODEX: Download = Download {
    version: Version::GithubLatest { repo: "openai/codex" },
    shape: Shape::Archive,
    // The release also carries `.zst` payloads and sigstore bundles. The zip and
    // the gzipped tar are taken because they are the two formats this crate reads.
    checksum: None,
    platforms: &[
        Platform { os: Os::Windows, arch: Arch::X64, plat: "x86_64-pc-windows-msvc", artifact: "codex-x86_64-pc-windows-msvc.exe.zip" },
        Platform { os: Os::Windows, arch: Arch::Arm64, plat: "aarch64-pc-windows-msvc", artifact: "codex-aarch64-pc-windows-msvc.exe.zip" },
        Platform { os: Os::Macos, arch: Arch::Arm64, plat: "aarch64-apple-darwin", artifact: "codex-aarch64-apple-darwin.tar.gz" },
        Platform { os: Os::Macos, arch: Arch::X64, plat: "x86_64-apple-darwin", artifact: "codex-x86_64-apple-darwin.tar.gz" },
        Platform { os: Os::Linux, arch: Arch::X64, plat: "x86_64-unknown-linux-musl", artifact: "codex-x86_64-unknown-linux-musl.tar.gz" },
        Platform { os: Os::Linux, arch: Arch::Arm64, plat: "aarch64-unknown-linux-musl", artifact: "codex-aarch64-unknown-linux-musl.tar.gz" },
    ],
};

const OPENCODE: Download = Download {
    version: Version::GithubLatest { repo: "sst/opencode" },
    shape: Shape::Archive,
    checksum: None,
    platforms: &[
        Platform { os: Os::Windows, arch: Arch::X64, plat: "windows-x64", artifact: "opencode-windows-x64.zip" },
        Platform { os: Os::Windows, arch: Arch::Arm64, plat: "windows-arm64", artifact: "opencode-windows-arm64.zip" },
        Platform { os: Os::Macos, arch: Arch::Arm64, plat: "darwin-arm64", artifact: "opencode-darwin-arm64.zip" },
        Platform { os: Os::Macos, arch: Arch::X64, plat: "darwin-x64", artifact: "opencode-darwin-x64.zip" },
        Platform { os: Os::Linux, arch: Arch::X64, plat: "linux-x64", artifact: "opencode-linux-x64.tar.gz" },
        Platform { os: Os::Linux, arch: Arch::Arm64, plat: "linux-arm64", artifact: "opencode-linux-arm64.tar.gz" },
    ],
};

const CURSOR: Download = Download {
    version: Version::Script {
        url: "https://cursor.com/install",
        needle: "https://downloads.cursor.com/lab/",
    },
    // A launcher beside its own runtime: pulling the launcher out on its own
    // gives a binary that cannot find what it loads. The vendor's installer
    // unpacks the tree and links the launcher, and so does this.
    shape: Shape::Package { entry: "cursor-agent" },
    checksum: None,
    // No Windows build: the vendor's installer refuses anything but Darwin and
    // Linux, so this machine gets the doc link instead of a button that fails.
    platforms: &[
        Platform { os: Os::Macos, arch: Arch::Arm64, plat: "darwin-arm64", artifact: "https://downloads.cursor.com/lab/{version}/darwin/arm64/agent-cli-package.tar.gz" },
        Platform { os: Os::Macos, arch: Arch::X64, plat: "darwin-x64", artifact: "https://downloads.cursor.com/lab/{version}/darwin/x64/agent-cli-package.tar.gz" },
        Platform { os: Os::Linux, arch: Arch::X64, plat: "linux-x64", artifact: "https://downloads.cursor.com/lab/{version}/linux/x64/agent-cli-package.tar.gz" },
        Platform { os: Os::Linux, arch: Arch::Arm64, plat: "linux-arm64", artifact: "https://downloads.cursor.com/lab/{version}/linux/arm64/agent-cli-package.tar.gz" },
    ],
};

/// The ten agents, in the order the settings panel draws them.
pub const CLIS: &[Cli] = &[
    Cli {
        id: "claude",
        exe: "claude",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Download(CLAUDE),
        data: &[DataDir { base: Base::Home, path: ".claude" }],
    },
    Cli {
        id: "codex",
        exe: "codex",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Download(CODEX),
        data: &[DataDir { base: Base::Home, path: ".codex" }],
    },
    Cli {
        id: "opencode",
        exe: "opencode",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Download(OPENCODE),
        data: &[
            DataDir { base: Base::Config, path: "opencode" },
            DataDir { base: Base::Data, path: "opencode" },
            DataDir { base: Base::DataLocal, path: "opencode" },
        ],
    },
    Cli {
        id: "cursor",
        exe: "cursor-agent",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Download(CURSOR),
        data: &[DataDir { base: Base::Home, path: ".cursor" }],
    },
    Cli {
        id: "antigravity",
        exe: "agy",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Manual,
        data: &[DataDir { base: Base::Home, path: ".gemini/antigravity-cli" }],
    },
    Cli {
        id: "copilot",
        // The extension is what gets installed; `gh` itself is the user's to
        // install, which is why it is what `requires` names.
        exe: "gh",
        // `gh --version` is gh's, not the extension's, and a number that names
        // the wrong tool is worse than no number.
        version_arg: None,
        presence: Presence::Listed {
            argv: &["gh", "extension", "list"],
            needle: "gh-copilot",
        },
        source: Source::Managed {
            requires: "gh",
            requires_url: "https://cli.github.com",
            install: &["gh", "extension", "install", "github/gh-copilot"],
            update: &["gh", "extension", "upgrade", "gh-copilot"],
            uninstall: &["gh", "extension", "remove", "gh-copilot"],
        },
        data: &[DataDir { base: Base::Home, path: ".copilot" }],
    },
    Cli {
        id: "grok",
        exe: "grok",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Download(GROK),
        data: &[DataDir { base: Base::Home, path: ".grok" }],
    },
    Cli {
        id: "hermes",
        exe: "hermes",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Manual,
        data: &[DataDir { base: Base::Home, path: ".hermes" }],
    },
    Cli {
        id: "pi",
        exe: "pi",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Manual,
        data: &[DataDir { base: Base::Home, path: ".pi" }],
    },
    Cli {
        id: "muse",
        exe: "muse",
        version_arg: Some("--version"),
        presence: Presence::Exe,
        source: Source::Manual,
        data: &[],
    },
];

/// The catalogue entry for an id, or `None` for an id nothing knows.
pub fn find(id: &str) -> Option<&'static Cli> {
    CLIS.iter().find(|c| c.id == id)
}

impl Download {
    /// The platform entry for this machine, or `None` where the vendor has no build.
    pub fn platform(&self) -> Option<&'static Platform> {
        let (os, arch) = host_target()?;
        self.platforms.iter().find(|p| p.os == os && p.arch == arch)
    }
}

impl Cli {
    /// The file name the executable takes inside the managed bin directory.
    pub fn file_name(&self) -> String {
        if cfg!(windows) {
            format!("{}.exe", self.exe)
        } else {
            self.exe.to_string()
        }
    }

    /// Whether this machine can install it at all, which the panel draws as a
    /// button that is there or a doc link that is all there is.
    pub fn installable(&self) -> bool {
        match &self.source {
            Source::Download(download) => download.platform().is_some(),
            Source::Managed { .. } => true,
            Source::Manual => false,
        }
    }
}

impl DataDir {
    /// The absolute path, or `None` when the base directory itself is unknown.
    ///
    /// The three platform bases are read from `dirs`, which knows nothing about the
    /// home a test pointed `BOITE_CLI_HOME` at — so under an override they answer
    /// nothing at all rather than the real `%APPDATA%`. A test home that reached
    /// half of the developer's own directories would be no test home.
    pub fn resolve(&self) -> Option<PathBuf> {
        let base = match self.base {
            Base::Home => super::home_dir(),
            Base::Config if super::home_overridden() => None,
            Base::Data if super::home_overridden() => None,
            Base::DataLocal if super::home_overridden() => None,
            Base::Config => dirs::config_dir(),
            Base::Data => dirs::data_dir(),
            Base::DataLocal => dirs::data_local_dir(),
        }?;
        Some(base.join(self.path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every entry is reachable by the id the webview sends, and no id is spelled
    /// twice: a duplicate would shadow the second entry for good.
    #[test]
    fn every_id_is_unique_and_findable() {
        for cli in CLIS {
            assert!(find(cli.id).is_some(), "{} is not findable", cli.id);
            assert_eq!(
                CLIS.iter().filter(|c| c.id == cli.id).count(),
                1,
                "{} is in the table twice",
                cli.id
            );
        }
    }

    /// A download the host has no platform row for is not installable, and one it
    /// does have a row for names an artifact carrying the version placeholder or
    /// an asset name. Pinned because the failure is silent otherwise: a template
    /// that lost its `{version}` downloads a 404 body and installs it.
    #[test]
    fn every_platform_row_names_something_substitutable() {
        for cli in CLIS {
            let Source::Download(download) = &cli.source else {
                continue;
            };
            assert!(
                !download.platforms.is_empty(),
                "{} downloads from nowhere",
                cli.id
            );
            for platform in download.platforms {
                let names_a_url = platform.artifact.starts_with("https://");
                let carries_version = platform.artifact.contains("{version}");
                assert!(
                    names_a_url == carries_version || !names_a_url,
                    "{} {} names a URL with no version in it",
                    cli.id,
                    platform.plat
                );
                assert!(!platform.plat.is_empty(), "{} has a nameless platform", cli.id);
            }
            let mut seen = std::collections::HashSet::new();
            for platform in download.platforms {
                assert!(
                    seen.insert((platform.os, platform.arch)),
                    "{} names {:?} twice",
                    cli.id,
                    platform.plat
                );
            }
        }
    }

    /// A manual entry has no install line, and a managed one has all three: a
    /// half-filled row would draw a button that runs an empty command.
    #[test]
    fn a_source_is_either_complete_or_manual() {
        for cli in CLIS {
            match &cli.source {
                Source::Managed {
                    requires,
                    requires_url,
                    install,
                    update,
                    uninstall,
                } => {
                    assert!(!requires.is_empty(), "{} requires nothing", cli.id);
                    // Where to get it, or the row is a dead end that names a tool
                    // and leaves the user to find it.
                    assert!(
                        requires_url.starts_with("https://"),
                        "{} points nowhere for {requires}",
                        cli.id
                    );
                    for line in [install, update, uninstall] {
                        assert!(line.len() >= 2, "{} has a one-word command line", cli.id);
                    }
                }
                Source::Download(_) | Source::Manual => {}
            }
            assert!(!cli.installable() || !matches!(cli.source, Source::Manual));
        }
    }
}
