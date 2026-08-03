//! Reading and writing what is on disk, and the folders a project lives in.
//!
//! Eight capabilities that were written twice. Two of the differences between
//! the two copies were bugs rather than choices, and both are named on the
//! commands that carry them: `project.folderState` and `file.readBase64`.

use serde_json::{json, Value};

use super::{str_param, u32_param, value_of, Access, Command, Host, Ready, Wire};
use crate::capability::Capability;
use crate::{editor, explorer, project};

/// Every method in this domain, in the order they appear below.
pub const ALL_METHODS: &[&str] = &[
    "fs.readDir",
    "fs.search",
    "file.read",
    "file.write",
    "file.readBase64",
    "project.inspect",
    "project.folderState",
    "project.createFolder",
];

#[derive(Debug, Clone, PartialEq)]
pub enum Files {
    ReadDir {
        path: String,
    },
    Search {
        path: String,
        query: String,
        limit: u32,
    },
    Read {
        path: String,
    },
    Write {
        path: String,
        content: String,
    },
    /// A whole file as base64, for a pane to draw: PDFs and images, which
    /// [`Files::Read`] refuses at the first NUL byte.
    ///
    /// The desktop has had this since panes could hold a document. The server
    /// never did, so the remote backend answered `not-supported-remote` and a
    /// PDF in a pane on a remote workspace was a blank frame. Nothing about it
    /// was server-specific; it was simply never retyped.
    ReadBase64 {
        path: String,
    },
    /// What a folder says about itself before it is a project: a name, an icon,
    /// a remote.
    ///
    /// Not scoped through the registered roots, and it cannot be: inspection is
    /// what produces the name a project is created *with*, so it necessarily
    /// runs before that folder is a root. What it may reveal is capped in
    /// `project::inspect_project_blocking` instead — `.git/config` remotes, plus
    /// an image from a fixed list of subdirectories, image extensions only,
    /// 2 MB max. Keep it that way.
    Inspect {
        path: String,
    },
    /// Whether anything is sitting where a project wants to go.
    ///
    /// Three words, no listing, and the answer for a folder that does not exist
    /// yet is `Missing` — which is the question the setup wizard asks. The
    /// server used to canonicalize the path before answering, so on that side
    /// the one case this exists for was the one case that failed.
    FolderState {
        path: String,
    },
    /// Makes the folder a new project will live in.
    ///
    /// The one command that creates a directory outside every registered root,
    /// which it has to: a project's folder is not a root until the project
    /// exists. The boundary is *where* instead — beside a project the user
    /// already has, or under their home. An agent reaches this through the MCP
    /// endpoint, so a free-form `create_dir_all` was never an option.
    CreateFolder {
        path: String,
    },
}

impl Files {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        let path = || str_param(params, "path");
        Ok(match method {
            "fs.readDir" => Files::ReadDir { path: path()? },
            "fs.search" => Files::Search {
                path: path()?,
                query: str_param(params, "query")?,
                limit: u32_param(params, "limit", 200),
            },
            "file.read" => Files::Read { path: path()? },
            "file.write" => Files::Write {
                path: path()?,
                content: str_param(params, "content")?,
            },
            "file.readBase64" => Files::ReadBase64 { path: path()? },
            "project.inspect" => Files::Inspect { path: path()? },
            "project.folderState" => Files::FolderState { path: path()? },
            "project.createFolder" => Files::CreateFolder { path: path()? },
            other => return Err(format!("unknown method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Files::ReadDir { .. } => "fs.readDir",
            Files::Search { .. } => "fs.search",
            Files::Read { .. } => "file.read",
            Files::Write { .. } => "file.write",
            Files::ReadBase64 { .. } => "file.readBase64",
            Files::Inspect { .. } => "project.inspect",
            Files::FolderState { .. } => "project.folderState",
            Files::CreateFolder { .. } => "project.createFolder",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Files::ReadDir { .. } => Wire::Key("entries"),
            Files::Search { .. } => Wire::Key("hits"),
            Files::Read { .. } => Wire::Bare,
            Files::Write { .. } => Wire::Key("bytes"),
            Files::ReadBase64 { .. } => Wire::Key("base64"),
            Files::Inspect { .. } => Wire::Bare,
            Files::FolderState { .. } => Wire::Bare,
            Files::CreateFolder { .. } => Wire::Ok,
        }
    }

    /// What a caller needs to hold to ask for this.
    ///
    /// `project.createFolder` is a mutation of the project it belongs to rather
    /// than one across projects, even though the folder is not a project yet:
    /// making a directory somewhere the boundary already allows changes nothing
    /// about where the caller works. Deciding to *move* there is
    /// `thread.move`, and that is the call that needs the wider grant.
    pub(super) fn capability(&self) -> Capability {
        match self {
            Files::ReadDir { .. }
            | Files::Search { .. }
            | Files::Read { .. }
            | Files::ReadBase64 { .. }
            | Files::Inspect { .. }
            | Files::FolderState { .. } => Capability::ReadProject,

            Files::Write { .. } | Files::CreateFolder { .. } => Capability::MutateProject,
        }
    }

    /// What the caller handed over, and what it wants to do with it.
    ///
    /// The three project commands are not in here: they run on folders that are
    /// not projects yet, and their boundary is [`Host::ensure_new_project_path`]
    /// rather than the registered roots.
    fn caller_paths(&self) -> Vec<(&str, Access)> {
        match self {
            Files::ReadDir { path }
            | Files::Search { path, .. }
            | Files::Read { path }
            | Files::ReadBase64 { path } => vec![(path, Access::Read)],
            Files::Write { path, .. } => vec![(path, Access::Write)],
            Files::Inspect { .. } | Files::FolderState { .. } | Files::CreateFolder { .. } => {
                Vec::new()
            }
        }
    }

    pub(super) fn prepare(self, host: &dyn Host) -> Result<Ready, String> {
        for (path, access) in self.caller_paths() {
            access.ensure(host, path)?;
        }
        match &self {
            Files::Inspect { path } | Files::FolderState { path } => {
                host.ensure_new_project_path(path)?;
            }
            Files::CreateFolder { path } => {
                host.ensure_new_project_path(path)?;
                let mut allowed = host.roots().new_project_parents();
                allowed.extend(host.extra_project_parents());
                if !project::may_create_project_at(path, &allowed) {
                    return Err(project::WRONG_PLACE_FOR_A_PROJECT.into());
                }
            }
            _ => {}
        }
        Ok(Ready::Work(Command::Files(self)))
    }

    pub(super) fn run(self) -> Result<Value, String> {
        Ok(match self {
            Files::ReadDir { path } => value_of(explorer::read_dir_blocking(path)?),
            Files::Search { path, query, limit } => {
                value_of(explorer::search_blocking(&path, &query, limit)?)
            }
            Files::Read { path } => value_of(editor::read_blocking(&path)?),
            Files::Write { path, content } => value_of(editor::write_blocking(&path, &content)?),
            Files::ReadBase64 { path } => value_of(editor::read_base64_blocking(&path)?),
            Files::Inspect { path } => value_of(project::inspect_project_blocking(path)?),
            Files::FolderState { path } => value_of(project::folder_state_blocking(&path)),
            Files::CreateFolder { path } => {
                // Asked after the boundary, because the answer changes what the
                // caller is told: a folder outside the allowed places is a
                // refusal about where, not about what is in it.
                if project::folder_state_blocking(&path) == project::FolderState::Occupied {
                    return Err("there is already something in that folder".into());
                }
                std::fs::create_dir_all(&path)
                    .map_err(|e| format!("cannot create the folder: {e}"))?;
                json!(null)
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Grant;
    use crate::command::Scoped;
    use crate::scope::ProjectRoots;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "boite-command-files-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn every_method_decodes_and_names_itself_back() {
        let params = json!({
            "path": "/tmp/whatever",
            "query": "needle",
            "limit": 5,
            "content": "hello",
        });
        for method in ALL_METHODS {
            let command = Command::decode(method, &params)
                .unwrap_or_else(|err| panic!("{method} did not decode: {err}"));
            assert_eq!(command.name(), *method);
        }
    }

    /// The five path-taking commands stay inside the registered roots. The three
    /// project ones are not in that set on purpose, and the test says so rather
    /// than leaving the gap to be read as an oversight.
    #[test]
    fn no_file_command_reads_or_writes_outside_the_registered_roots() {
        let outside = scratch("outside");
        std::fs::write(outside.join("a.txt"), "x").unwrap();
        let roots = ProjectRoots::default();
        roots.replace(vec![scratch("root").to_string_lossy().to_string()]);
        let host = Scoped::new(&roots);

        for method in ["fs.readDir", "fs.search", "file.read", "file.readBase64"] {
            let params = json!({ "path": outside.join("a.txt").to_str().unwrap(), "query": "x" });
            let err = Command::decode(method, &params)
                .unwrap()
                .prepare(&host, Grant::Local)
                .err()
                .unwrap_or_else(|| panic!("{method} accepted a path outside the roots"));
            assert!(err.contains("outside registered project roots"), "{method}: {err}");
        }
        // The write boundary is the parent's, so a file that does not exist yet
        // is still refused by the directory holding it.
        let params = json!({
            "path": outside.join("new.txt").to_str().unwrap(),
            "content": "x",
        });
        assert!(Command::decode("file.write", &params)
            .unwrap()
            .prepare(&host, Grant::Local)
            .is_err());
    }

    /// The whole point of the command: a folder that is not there yet answers
    /// `Missing`. The server used to canonicalize first, so the one case this
    /// exists for — the setup wizard asking about a folder it is about to make —
    /// was the one case that failed.
    #[test]
    fn a_folder_that_does_not_exist_answers_missing() {
        let base = scratch("missing");
        let roots = ProjectRoots::default();
        let host = Scoped::new(&roots);
        let params = json!({ "path": base.join("not-yet").to_str().unwrap() });
        let answer = Command::decode("project.folderState", &params)
            .unwrap()
            .prepare(&host, Grant::Local)
            .unwrap()
            .run()
            .unwrap();
        assert_eq!(answer, json!("missing"));
    }

    /// A new project folder goes beside one the user already has, or under their
    /// home, and nowhere else.
    #[test]
    fn a_project_folder_only_goes_where_a_project_may_go() {
        let base = scratch("create");
        std::fs::create_dir_all(base.join("dev").join("thing")).unwrap();
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        // Somebody's work, so the folder reads as occupied rather than empty.
        std::fs::write(base.join("dev").join("thing").join("README.md"), "mine").unwrap();
        let roots = ProjectRoots::default();
        roots.replace(vec![base.join("dev").join("thing").to_string_lossy().to_string()]);
        // No home in the allowed list: the scratch folder lives under the real
        // one, and a test that leaves it in cannot tell a refusal from a pass.
        let host = Scoped::new(&roots).with_extra_project_parents(Vec::new());
        let ask = |path: &std::path::Path| {
            Command::decode("project.createFolder", &json!({ "path": path.to_str().unwrap() }))
                .unwrap()
                .prepare(&host, Grant::Local)
        };

        assert!(ask(&base.join("elsewhere").join("newproj")).is_err());
        let allowed = base.join("dev").join("newproj");
        ask(&allowed).unwrap().run().unwrap();
        assert!(allowed.is_dir());
        // And it will not take a folder somebody is already using.
        assert!(ask(&base.join("dev").join("thing")).unwrap().run().is_err());
    }
}
