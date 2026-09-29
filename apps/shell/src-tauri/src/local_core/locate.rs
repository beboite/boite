//! Where the core lives: the data directory it is told to use, and the
//! command line that starts it, from the sidecar, a repository build or its
//! sources.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::channel::Channel;
use crate::platform::default_data_dir;

/// The command line that starts the core.
#[derive(Clone, Debug)]
pub(super) struct CoreCommand {
    pub(super) program: String,
    pub(super) args: Vec<String>,
    pub(super) working_directory: Option<PathBuf>,
}

fn data_dir(channel: Channel) -> Result<PathBuf, String> {
    match std::env::var("BOITE_DATA_DIR") {
        Ok(value) if !value.trim().is_empty() => Ok(PathBuf::from(value.trim())),
        _ => default_data_dir(channel),
    }
}

/// `data_dir` for `run()`: an unresolvable `%APPDATA%` (or `HOME`) no longer
/// panics before any window exists. The OS temp directory is the fallback,
/// present on every platform this ships to, so the shell still starts and
/// says, in a line an attached terminal or log redirection can show, why its
/// data now lives there instead.
pub(crate) fn resolve_data_dir(channel: Channel) -> PathBuf {
    match data_dir(channel) {
        Ok(directory) => directory,
        Err(error) => {
            eprintln!("[shell] {error}; falling back to a data directory under the OS temp directory");
            std::env::temp_dir().join(channel.data_dir_name())
        }
    }
}

fn repo_root() -> Option<PathBuf> {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }

    for start in starts {
        let mut current: Option<&Path> = Some(start.as_path());
        while let Some(directory) = current {
            if let Ok(text) = std::fs::read_to_string(directory.join("package.json")) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value.get("name").and_then(serde_json::Value::as_str) == Some("boite") {
                        return Some(directory.to_path_buf());
                    }
                }
            }
            current = directory.parent();
        }
    }
    None
}

/// The sidecar beside this executable and the arguments that make it the core.
/// A `core/main.js` beside it means the sidecar is the Bun runtime under the
/// core's name (the Windows installer, see `stage-sidecar.ts`) and the bundle is
/// its script; without one the sidecar is the compiled core and takes nothing.
fn sidecar() -> Result<Option<(PathBuf, Vec<String>)>, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let name = if cfg!(windows) {
        "boite-core.exe"
    } else {
        "boite-core"
    };
    let directory = exe.parent().ok_or("the shell executable has no parent directory")?;
    let path = directory.join(name);
    if !path.exists() { return Ok(None); }
    #[cfg(windows)]
    check_workers(directory)?;
    Ok(Some((path, bundle_args(directory))))
}

fn bundle_args(directory: &Path) -> Vec<String> {
    let bundle = directory.join("core").join("main.js");
    if bundle.is_file() {
        vec![bundle.display().to_string()]
    } else {
        Vec::new()
    }
}

#[cfg(any(windows, test))]
fn check_workers(directory: &Path) -> Result<(), String> {
    for name in ["jobs-worker.js", "guard-worker.js"] {
        let worker = directory.join(name);
        if !worker.is_file() {
            return Err(format!("missing core worker: {}. Reinstall or run bun run stage:core", worker.display()));
        }
    }
    Ok(())
}

/// In order: `BOITE_CORE_COMMAND`, the `boite-core` sidecar next to this
/// executable, the core bundle a repository above it has built, its sources.
/// Whatever the source, the channel and the data directory ride on the argv:
/// the core writes its `core.json` in the directory this shell then reads.
pub(super) fn core_command(channel: Channel, directory: &Path) -> Result<CoreCommand, String> {
    let (program, mut args, working_directory) = core_program()?;
    args.extend(core_args(channel, directory));
    Ok(CoreCommand { program, args, working_directory })
}

/// What the shell appends to the core's argv. `--data-dir` is the directory the
/// shell resolved, so a fallback the shell took (no `%LOCALAPPDATA%`, a
/// `BOITE_DATA_DIR` padded with spaces) is the core's too.
pub(super) fn core_args(channel: Channel, directory: &Path) -> Vec<String> {
    let mut args = channel.core_args();
    args.extend(["--data-dir".to_string(), directory.display().to_string()]);
    args
}

/// Where the core comes from, with no opinion on the channel.
fn core_program() -> Result<(String, Vec<String>, Option<PathBuf>), String> {
    if let Ok(raw) = std::env::var("BOITE_CORE_COMMAND") {
        let mut parts = raw.split_whitespace().map(str::to_string);
        let program = parts
            .next()
            .ok_or_else(|| "BOITE_CORE_COMMAND is set but empty".to_string())?;
        return Ok((program, parts.collect(), None));
    }

    if let Some((path, args)) = sidecar()? {
        return Ok((path.display().to_string(), args, None));
    }

    let repo = repo_root().ok_or_else(|| {
        "no boite-core sidecar next to the executable, and no package.json named \"boite\" above it"
            .to_string()
    })?;
    let core = repo.join("packages").join("core");
    let bundle = core.join("dist").join("main.js");
    let entry = if bundle.exists() {
        bundle
    } else {
        core.join("src").join("main.ts")
    };
    Ok((
        "bun".to_string(),
        vec!["run".to_string(), entry.display().to_string()],
        Some(repo),
    ))
}

/// Tauri keeps resources separate from executables on Linux and macOS.
pub(super) fn configure_core_resources(command: &mut Command, resources: &Path) {
    let ui = resources.join("ui");
    if ui.join("index.html").is_file() { command.env("BOITE_UI_DIR", ui); }
    #[cfg(not(windows))]
    if resources.join("boite").is_file()
        && Path::new(command.get_program()).is_absolute()
        && Path::new(command.get_program()).file_name().is_some_and(|name| name == "boite-core")
    {
        let executable = command.get_program().to_os_string();
        command.env("BOITE_CORE_EXECUTABLE", executable);
        if std::env::var_os("BOITE_CLI_DIR").filter(|value| !value.is_empty()).is_none() {
            command.env("BOITE_CLI_DIR", resources);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_sidecar_workers_are_required() {
        let directory = std::env::temp_dir().join(format!("boite-workers-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(super::check_workers(&directory).unwrap_err().contains("jobs-worker.js"));
        std::fs::write(directory.join("jobs-worker.js"), "").unwrap();
        assert!(super::check_workers(&directory).unwrap_err().contains("guard-worker.js"));
        std::fs::write(directory.join("guard-worker.js"), "").unwrap();
        assert!(super::check_workers(&directory).is_ok());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_bundle_beside_the_sidecar_becomes_its_script() {
        let directory = std::env::temp_dir().join(format!("boite-bundle-{}", std::process::id()));
        std::fs::create_dir_all(directory.join("core")).unwrap();
        assert!(super::bundle_args(&directory).is_empty());
        std::fs::write(directory.join("core").join("main.js"), "").unwrap();
        assert_eq!(super::bundle_args(&directory), vec![directory.join("core").join("main.js").display().to_string()]);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn the_core_is_told_the_data_directory_the_shell_resolved() {
        let directory = Path::new("C:/Users/x/AppData/Local/boite2 dev");
        let expected = ["--data-dir".to_string(), directory.display().to_string()];
        assert_eq!(core_args(Channel::Stable, directory), expected);
        let dev = core_args(Channel::Dev, directory);
        assert_eq!(dev[..2], ["--channel".to_string(), "dev".to_string()]);
        assert!(dev.ends_with(&expected));
    }
}
