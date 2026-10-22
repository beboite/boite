//! `boite.exe`, installed beside `boite.cmd`. Windows finds it first, before
//! the `.cmd`, for a command named `boite`. A `.cmd` always runs through
//! cmd.exe, which ends the command at an unquoted `&` that PowerShell passes
//! bare, so a URL with a query lost everything after its first `&`
//! (2026-10-22). This program starts the core directly, each argument as it
//! came, and ends with the core's exit code. It does what `shims/boite` does.
use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{exit, Command};

/// The core executable and the arguments before the user's: the bundle beside
/// a runtime when there is one, then `cli`.
fn invocation(core: PathBuf, bundle_exists: impl Fn(&PathBuf) -> bool) -> (PathBuf, Vec<OsString>) {
    let mut lead = Vec::new();
    if let Some(directory) = core.parent() {
        let bundle = directory.join("core").join("main.js");
        if bundle_exists(&bundle) {
            lead.push(bundle.into_os_string());
        }
    }
    lead.push(OsString::from("cli"));
    (core, lead)
}

/// `BOITE_CORE_EXECUTABLE` when the shell names it, else `boite-core.exe` beside this file.
fn core_path() -> Result<PathBuf, String> {
    if let Some(named) = env::var_os("BOITE_CORE_EXECUTABLE").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(named));
    }
    let own = env::current_exe()
        .map_err(|error| format!("boite: cannot find its own location: {error}"))?;
    let directory = own
        .parent()
        .ok_or("boite: its own location has no directory")?;
    Ok(directory.join("boite-core.exe"))
}

fn main() {
    let core = match core_path() {
        Ok(core) => core,
        Err(message) => {
            eprintln!("{message}");
            exit(1);
        }
    };
    let (program, lead) = invocation(core, |bundle| bundle.is_file());
    match Command::new(&program)
        .args(lead)
        .args(env::args_os().skip(1))
        .status()
    {
        // A core ended by a signal has no code; 1 says it failed.
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("boite: could not start {}: {error}", program.display());
            exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::invocation;
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn the_bundle_beside_a_runtime_goes_before_cli() {
        let core = PathBuf::from("app").join("boite-core.exe");
        let bundle = PathBuf::from("app").join("core").join("main.js");
        let (program, lead) = invocation(core.clone(), |path| *path == bundle);
        assert_eq!(program, core);
        assert_eq!(lead, vec![bundle.into_os_string(), OsString::from("cli")]);
        let (_, lead) = invocation(core, |_| false);
        assert_eq!(lead, vec![OsString::from("cli")]);
    }
}
