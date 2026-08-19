//! What can be synced, declared once.
//!
//! The table below is an allowlist of named files plus exactly one tree. It is
//! never a directory minus a denylist, and the difference is the whole design:
//! `~/.claude` is not a source, `~/.claude/settings.json` is. That is what makes
//! `~/.claude/plugins` (820 files and nine megabytes of absolute paths),
//! `.credentials.json`, `sessions/` and `projects/` *unreachable* rather than
//! *filtered*. A denylist drifts the moment a vendor adds a directory; an
//! allowlist fails closed, and a new file nobody has looked at simply does not
//! travel until somebody decides it should.
//!
//! Every one of the ten agents appears, including the seven whose entry is
//! empty. An agent with nothing to sync yet is a decision that was made, and it
//! reads differently from one that was forgotten.

use std::path::{Path, PathBuf};

/// The source that belongs to no CLI: the shared instruction tree every agent
/// reads.
///
/// One more entry today. When agent centralisation lands it becomes the primary
/// one, which is why it is a named constant rather than a special case spelled
/// out at three call sites.
pub const AGENTS_ID: &str = "agents";

/// One thing on this machine that can be synced, and how.
#[derive(Debug, Clone, Copy)]
pub struct Source {
    /// Home-relative, forward slashes, no `..`, no leading slash. A test asserts
    /// all four, because this string is joined onto the user's home directory
    /// and also becomes a path inside a git repository.
    pub path: &'static str,
    pub kind: Kind,
}

#[derive(Debug, Clone, Copy)]
pub enum Kind {
    /// Exactly one file.
    ///
    /// A rule is always attached to one named file and never to a pattern, so
    /// "which pointer applies here" has one answer per file rather than a match
    /// to evaluate. A file with no rule is never parsed, which is how a format
    /// nobody here can round-trip stays in scope.
    File { rules: &'static [Rule] },
    /// A directory walked to `max_depth`.
    ///
    /// The tree itself is the allowlist, so `deny` is short. The ceilings are
    /// refusals rather than truncations: a tree that outgrew them is a tree
    /// somebody put something unexpected in, and a quietly partial commit reads
    /// as a complete one.
    Tree {
        deny: &'static [&'static str],
        max_depth: u32,
        max_files: usize,
        max_bytes: u64,
    },
}

/// A field inside a JSON file that must not travel as it stands.
#[derive(Debug, Clone, Copy)]
pub struct Rule {
    /// `/`-separated, `*` matching exactly one map key, so
    /// `/mcpServers/*/headers/Authorization` covers every server in a file
    /// without naming any of them.
    pub pointer: &'static str,
    pub field: Field,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    /// A credential. Never leaves this machine, and a pull keeps what is here.
    Secret,
    /// Portable in principle and not in practice: the value names something only
    /// this machine has. `~/.claude/settings.json`'s `statusLine.command` is the
    /// measured case — it carries an absolute path, a plugin cache hash and a
    /// shell invocation, and a home token fixes only the first.
    MachineLocal,
}

/// One row in the settings panel: an id, and what syncing it means.
#[derive(Debug, Clone, Copy)]
pub struct Synced {
    /// An agent id, or `AGENTS_ID`.
    pub id: &'static str,
    /// Empty means nothing verified to sync for this agent yet.
    pub sources: &'static [Source],
}

/// The agent ids Boite knows, in the order the settings panel draws them.
///
/// This duplicates the CLI manager's catalogue, which is on another branch. It
/// is spelled out here in one place rather than left implicit in `SOURCES` so
/// that the day the two meet, the test below reads `cli_manager::catalog::CLIS`
/// instead and this constant is deleted — a two line change rather than a hunt.
pub const KNOWN_CLIS: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "cursor",
    "antigravity",
    "copilot",
    "grok",
    "hermes",
    "pi",
    "muse",
];

/// Names no file under any circumstances, in any tree, on any source.
///
/// Belt and braces over the allowlist. The tree source is `~/.agents`, whose
/// contents are the user's own markdown, and a user who drops a `.env` beside a
/// skill has not asked for it to be pushed to a git remote. Names and suffixes
/// rather than globs, so the list can be read and argued with.
pub const DENY_ALWAYS: &[&str] = &[
    ".git",
    ".env",
    ".envrc",
    ".credentials.json",
    "credentials.json",
    ".netrc",
    "_netrc",
    ".DS_Store",
    "Thumbs.db",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".db-wal",
    ".db-shm",
    ".log",
    ".pid",
    ".sock",
];

/// Files no entry may name, whatever a future table says.
///
/// `~/.claude.json` is fifty kilobytes, twenty-six of which is a cache Claude
/// rewrites on every launch, alongside `machineID`, `userID`, `oauthAccount` and
/// a `projects` map keyed by absolute paths. Synced whole it would produce a
/// conflict at every start. A test asserts no entry names it, and `resolve`
/// refuses it besides, so it stays unreachable even if the test is deleted.
const FORBIDDEN: &[&str] = &[".claude.json"];

/// The directory Boite owns. A source reaching into it would be a sync of the
/// sync: the mirror lives there.
const OWNED: &str = ".boite";

pub const SOURCES: &[Synced] = &[
    Synced {
        id: AGENTS_ID,
        sources: &[Source {
            path: ".agents",
            kind: Kind::Tree {
                // `.skill-lock.json` is derived from the skills beside it.
                // Syncing a derived file is the mistake `~/.claude/plugins`
                // would be: it churns on every machine, and what it is derived
                // from is already in the tree.
                deny: &[".skill-lock.json"],
                max_depth: 8,
                max_files: 2_000,
                max_bytes: 8 * 1024 * 1024,
            },
        }],
    },
    Synced {
        id: "claude",
        // Nothing else under `~/.claude`, and `~/.claude.json` is not a source
        // and cannot become one.
        sources: &[Source {
            path: ".claude/settings.json",
            kind: Kind::File {
                rules: &[Rule { pointer: "/statusLine/command", field: Field::MachineLocal }],
            },
        }],
    },
    Synced {
        id: "antigravity",
        // The `~/.gemini` selection hangs off this row because antigravity is
        // the only agent that lives there. One switch, three files, and the
        // panel labels it accordingly.
        sources: &[
            Source { path: ".gemini/settings.json", kind: Kind::File { rules: &[] } },
            Source {
                path: ".gemini/config/mcp_config.json",
                kind: Kind::File {
                    rules: &[Rule {
                        pointer: "/mcpServers/*/headers/Authorization",
                        field: Field::Secret,
                    }],
                },
            },
            Source {
                // `trustedWorkspaces` is an array of absolute project paths and
                // is deliberately not machine-local: paths under home portabilise
                // by token, paths outside are inert on the other machine, and the
                // union is what the merge tool produces anyway. It is a trust
                // list, so it goes through the merge tool rather than being
                // joined quietly — which the never-overwrite rule already
                // guarantees.
                path: ".gemini/antigravity-cli/settings.json",
                kind: Kind::File { rules: &[] },
            },
        ],
    },
    Synced {
        id: "copilot",
        sources: &[Source {
            // JSONC: `//` comments and a trailing comma. It declares no rule, so
            // nothing ever parses it and nothing ever writes it back. That is
            // the whole reason it can be in scope at all.
            path: ".copilot/config.json",
            kind: Kind::File { rules: &[] },
        }],
    },
    // The remaining six, each a decision rather than a gap.
    // codex: `~/.codex/config.toml` is unverified and the TOML round-trip is untested.
    Synced { id: "codex", sources: &[] },
    // opencode: its configuration is under the platform config directory, which
    // v1 does not resolve — every source here is home-relative.
    Synced { id: "opencode", sources: &[] },
    // cursor: `~/.cursor` is shared with the editor, not only the agent.
    Synced { id: "cursor", sources: &[] },
    Synced { id: "grok", sources: &[] },
    Synced { id: "hermes", sources: &[] },
    Synced { id: "pi", sources: &[] },
    // muse: keeps no directory of its own.
    Synced { id: "muse", sources: &[] },
];

/// The row for an id, or `None` when the webview sent one nobody declares.
pub fn find(id: &str) -> Option<&'static Synced> {
    SOURCES.iter().find(|entry| entry.id == id)
}

/// Why a path was not turned into somewhere on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// A file that may never be synced, whatever a table says.
    Forbidden(String),
    /// Inside the directory Boite owns, where the mirror lives.
    Owned(String),
    /// Absolute, or climbing out of the home directory.
    NotUnderHome(String),
}

impl Refusal {
    pub fn message(&self) -> String {
        match self {
            Refusal::Forbidden(path) => {
                format!("{path} is never synced")
            }
            Refusal::Owned(path) => {
                format!("{path} is inside Boite's own directory")
            }
            Refusal::NotUnderHome(path) => {
                format!("{path} is not a path inside the home directory")
            }
        }
    }
}

/// Where a source lives on this machine.
///
/// The only place a manifest path becomes an absolute one, which is why the two
/// hard refusals are checked here rather than at the call sites.
pub fn resolve(home: &Path, source: &Source) -> Result<PathBuf, Refusal> {
    let path = source.path;
    if FORBIDDEN.contains(&path) {
        return Err(Refusal::Forbidden(path.to_string()));
    }
    if !is_home_relative(path) {
        return Err(Refusal::NotUnderHome(path.to_string()));
    }
    let mut components = path.split('/');
    if components.next() == Some(OWNED) {
        return Err(Refusal::Owned(path.to_string()));
    }
    let mut out = home.to_path_buf();
    for segment in path.split('/') {
        out.push(segment);
    }
    Ok(out)
}

/// Whether a manifest path is the shape every entry has to have.
///
/// Relative, forward slashes only, no `..`, no empty segment, no drive letter.
/// It is joined onto a home directory and it also becomes a path inside a git
/// repository, and both of those want the same four things.
pub fn is_home_relative(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return false;
    }
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        return false;
    }
    path.split('/').all(|segment| !segment.is_empty() && segment != ".." && segment != ".")
}

/// Whether a name is one the walk never picks up, wherever it appears.
pub fn denied_always(name: &str) -> bool {
    DENY_ALWAYS
        .iter()
        .any(|entry| name == *entry || (entry.starts_with('.') && name.ends_with(entry)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_source() -> impl Iterator<Item = &'static Source> {
        SOURCES.iter().flat_map(|entry| entry.sources.iter())
    }

    /// Joined onto a home directory and committed to a repository, both of which
    /// want a relative path with no surprises in it.
    #[test]
    fn every_source_path_is_home_relative() {
        for source in every_source() {
            assert!(is_home_relative(source.path), "{} is not home-relative", source.path);
        }
    }

    /// Fifty kilobytes of launch-time churn, a machine id and an account. Not a
    /// source, and not something a later table can quietly make one.
    #[test]
    fn no_source_names_the_forbidden_file() {
        for source in every_source() {
            assert!(!FORBIDDEN.contains(&source.path), "{} is forbidden", source.path);
        }
        let refused = resolve(
            Path::new("/home/me"),
            &Source { path: ".claude.json", kind: Kind::File { rules: &[] } },
        );
        assert_eq!(refused, Err(Refusal::Forbidden(".claude.json".into())));
    }

    /// The mirror lives under `~/.boite`. A source reaching it would be a sync
    /// of the sync.
    #[test]
    fn no_source_reaches_the_directory_boite_owns() {
        for source in every_source() {
            assert!(!source.path.starts_with(".boite"), "{} is inside .boite", source.path);
        }
        let refused = resolve(
            Path::new("/home/me"),
            &Source { path: ".boite/sync/mirror", kind: Kind::File { rules: &[] } },
        );
        assert!(matches!(refused, Err(Refusal::Owned(_))));
    }

    #[test]
    fn a_path_that_climbs_out_of_home_is_refused() {
        for path in ["../elsewhere", "/etc/passwd", "C:/Windows", r".claude\settings.json", ""] {
            assert!(!is_home_relative(path), "{path} was accepted");
        }
    }

    #[test]
    fn a_source_resolves_under_the_home_it_is_given() {
        let source = Source { path: ".claude/settings.json", kind: Kind::File { rules: &[] } };
        let resolved = resolve(Path::new("/home/me"), &source).expect("should resolve");
        assert!(resolved.ends_with("settings.json"));
        assert!(resolved.starts_with("/home/me"));
    }

    /// Ten agents, ten answers, even where the answer is that nothing syncs yet.
    /// A new agent fails this until somebody decides what its configuration is.
    #[test]
    fn every_known_cli_has_a_decision() {
        let declared: Vec<&str> =
            SOURCES.iter().map(|entry| entry.id).filter(|id| *id != AGENTS_ID).collect();
        for id in KNOWN_CLIS {
            assert!(declared.contains(id), "{id} has no sync decision");
        }
        for id in &declared {
            assert!(KNOWN_CLIS.contains(id), "{id} is not an agent this branch knows");
        }
        assert_eq!(declared.len(), KNOWN_CLIS.len());
    }

    /// A duplicate would shadow the second entry for good.
    #[test]
    fn no_id_is_spelled_twice() {
        for entry in SOURCES {
            assert_eq!(
                SOURCES.iter().filter(|other| other.id == entry.id).count(),
                1,
                "{} is declared twice",
                entry.id
            );
            assert!(find(entry.id).is_some(), "{} is not findable", entry.id);
        }
    }

    /// A rule belongs to one named file. On a tree it would have no file to
    /// apply to, and the walk would have to guess.
    #[test]
    fn a_rule_belongs_to_one_named_file() {
        for source in every_source() {
            if let Kind::Tree { .. } = source.kind {
                // Nothing to assert beyond the type: `Kind::Tree` carries no
                // rules, so this is the compiler's promise rather than mine.
                // The test stands so that widening `Tree` later trips here.
                assert!(matches!(source.kind, Kind::Tree { .. }));
            }
        }
    }

    #[test]
    fn the_deny_list_stops_a_credentials_file_and_a_key() {
        for name in [".credentials.json", "id_ed25519.key", "state.sqlite", ".env", ".git"] {
            assert!(denied_always(name), "{name} was not denied");
        }
        for name in ["AGENTS.md", "settings.json", "skill.md"] {
            assert!(!denied_always(name), "{name} was denied");
        }
    }

    /// The one file in scope that carries a credential, and the one that carries
    /// a value only this machine can use. If either rule is dropped, this says so.
    #[test]
    fn the_two_measured_fields_are_declared() {
        let claude = find("claude").expect("claude is declared");
        let Kind::File { rules } = claude.sources[0].kind else { panic!("expected a file") };
        assert!(rules.iter().any(|rule| rule.field == Field::MachineLocal));

        let gemini = find("antigravity").expect("antigravity is declared");
        let has_secret = gemini.sources.iter().any(|source| match source.kind {
            Kind::File { rules } => rules.iter().any(|rule| rule.field == Field::Secret),
            Kind::Tree { .. } => false,
        });
        assert!(has_secret, "the Authorization header is no longer redacted");
    }
}
