//! `boite-mcp --dev`: the second mode of this binary.
//!
//! The normal mode is a door onto the boite that spawned it, and reads its
//! whole identity from the environment. This one has no boite behind it: it
//! *starts* one, the isolated dev window, and drives it. Everything it touches
//! belongs to `dev.boite.dev` and nothing to `com.boite.legacy`, which is the
//! reason it exists as a mode of the shipped binary rather than as a
//! third-party server pinned to a plugin's version.
//!
//! Six tools, one door each:
//!
//! | Tool | Door |
//! |---|---|
//! | `dev_window` | a `bun run dev:isolated` process tree in a job object |
//! | `dev_inspect` | `window.__boite` over the bridge's `execute_js` |
//! | `dev_drive` | the bridge's `execute_js` and `capture_native_screenshot` |
//! | `dev_logs` | `dev.boite.dev`'s log directory, read as files |
//! | `dev_db` | `dev.boite.dev`'s SQLite, opened read-only |
//! | `dev_scenario` | the repo's `e2e/*.e2e.ts`, listed and run through `bun run e2e` |
//!
//! The state is a `DevWindow` behind a mutex, and the process lives as long as
//! the MCP session: an agent that starts the window and asks nothing for ten
//! minutes still has it, and a client that disconnects takes it down with the
//! shim, the job object doing the reaping.

pub mod bridge;
mod call;
pub mod db;
pub mod paths;
pub mod scenario;
mod tools;
pub mod window;

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

use crate::rpc;
use crate::write_line;

use window::DevWindow;

/// What `--dev` was given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevArgs {
    /// The boite checkout `bun run dev:isolated` runs in.
    pub repo: PathBuf,
    /// The port the isolated config's vite serves on.
    pub port: u16,
}

/// The port `tauri.dev-isolated.conf.json` names, and the default here.
pub const DEFAULT_PORT: u16 = 1430;

impl DevArgs {
    /// Read `--repo <path>` and `--port <n>` off an argv.
    ///
    /// The repo defaults to the working directory rather than to a guess: this
    /// binary lives in a `target/` under some checkout, and inferring the repo
    /// from its own path would pick whichever one built it, which is not
    /// necessarily the one an agent is working in.
    pub fn parse(args: &[String]) -> Result<DevArgs, String> {
        let mut repo: Option<PathBuf> = None;
        let mut port = DEFAULT_PORT;
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--repo" => {
                    let value = args
                        .get(i + 1)
                        .filter(|v| !v.starts_with("--"))
                        .ok_or("--repo needs a path")?;
                    repo = Some(PathBuf::from(value));
                    i += 2;
                }
                "--port" => {
                    let value = args.get(i + 1).ok_or("--port needs a number")?;
                    port = value
                        .parse()
                        .map_err(|_| format!("--port is not a port: {value}"))?;
                    i += 2;
                }
                // `--dev`, `--log-dir <dir>` and anything a client adds are
                // not this parser's business: an unknown flag is skipped
                // rather than refused, so a launcher may pass its own.
                _ => i += 1,
            }
        }
        let repo = match repo {
            Some(path) => path,
            None => std::env::current_dir().map_err(|e| format!("no working directory: {e}"))?,
        };
        if !repo.join("package.json").is_file() {
            return Err(format!(
                "{} is not a boite checkout: no package.json. Pass --repo <path>.",
                repo.display()
            ));
        }
        Ok(DevArgs { repo, port })
    }
}

/// The one piece of state the dev server holds.
pub struct Dev {
    pub window: Mutex<DevWindow>,
}

impl Dev {
    pub fn new(args: DevArgs) -> Dev {
        Dev {
            window: Mutex::new(DevWindow::new(args.repo, args.port)),
        }
    }
}

/// The stdio loop for `--dev`, the same engine the normal mode runs.
///
/// It answers `initialize` before anything is checked, for the reason
/// `main.rs` gives: a client can only report a connection that closed during
/// the handshake as "connection closed", which hides a cause that is one
/// sentence long. A bad `--repo` becomes that sentence at the first call.
pub fn run(args: &[String]) {
    let parsed = DevArgs::parse(args);
    let dev = parsed.as_ref().ok().cloned().map(Dev::new);

    let call = |name: &str, arguments: &Value| match (&dev, &parsed) {
        (Some(dev), _) => call::call_dev_tool(dev, name, arguments),
        (None, Err(why)) => Err(why.clone()),
        (None, Ok(_)) => Err("the dev server did not start".to_string()),
    };
    let blocks = |_name: &str, _args: &Value| None;
    let service = rpc::Service {
        call: &call,
        blocks: Some(&blocks),
        tools: tools::dev_tools(),
        instructions: tools::DEV_INSTRUCTIONS,
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in std::io::BufRead::lines(stdin.lock()) {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(reply) = rpc::answer(&service, &msg) {
            write_line(&mut stdout, &reply);
        }
    }
    // The client went away. The window this shim started goes with it: `Dev`
    // drops its `DevWindow`, which closes the job object.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_repo_and_a_port_are_read_off_the_argv() {
        let repo = std::env::current_dir().expect("cwd");
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        // The crate directory has no package.json; the repo root two levels up
        // has, and is what a launcher passes.
        let root = manifest.parent().and_then(|p| p.parent()).expect("root");
        let parsed = DevArgs::parse(&argv(&[
            "--dev",
            "--repo",
            &root.display().to_string(),
            "--port",
            "1431",
        ]))
        .expect("parsed");
        assert_eq!(parsed.repo, *root);
        assert_eq!(parsed.port, 1431);
        drop(repo);
    }

    #[test]
    fn the_port_defaults_to_the_isolated_configs_own() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest.parent().and_then(|p| p.parent()).expect("root");
        let parsed =
            DevArgs::parse(&argv(&["--dev", "--repo", &root.display().to_string()])).expect("parsed");
        assert_eq!(parsed.port, DEFAULT_PORT);
        assert_eq!(DEFAULT_PORT, 1430);
    }

    #[test]
    fn an_unknown_flag_is_passed_over_rather_than_refused() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root = manifest.parent().and_then(|p| p.parent()).expect("root");
        let parsed = DevArgs::parse(&argv(&[
            "--dev",
            "--log-dir",
            "C:\\somewhere",
            "--repo",
            &root.display().to_string(),
        ]))
        .expect("parsed");
        assert_eq!(parsed.repo, *root);
    }

    #[test]
    fn a_directory_that_is_not_a_checkout_says_so() {
        let temp = std::env::temp_dir();
        let error = DevArgs::parse(&argv(&["--dev", "--repo", &temp.display().to_string()]))
            .expect_err("refused");
        assert!(error.contains("package.json"), "{error}");
    }

    #[test]
    fn a_flag_with_nothing_behind_it_is_refused() {
        assert!(DevArgs::parse(&argv(&["--dev", "--repo"])).is_err());
        assert!(DevArgs::parse(&argv(&["--dev", "--port", "not-a-port"])).is_err());
    }
}
