//! `dev_scenario`: the end-to-end suite, listed and run.
//!
//! The scenarios are files, `e2e/*.e2e.ts`, and the runner is the repo's own
//! `bun run e2e`. Nothing here re-implements vitest: an agent asking for a
//! scenario and a person typing the script must run the same thing, or the
//! answer this tool gives is about a runner nobody else uses.
//!
//! Two rules it shares with [`super::window`]: the whole `bun` tree goes into
//! a [`Job`] captured at spawn and is stopped by closing that handle, never by
//! name; and the wait has a deadline, because a scenario that hangs would
//! otherwise hold this session for as long as the client is willing to sit
//! there.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use boite_core::job::Job;

use crate::toon::Toon;

/// Long enough for a suite whose first scenario waits out a cold debug build.
pub const RUN_DEADLINE: Duration = Duration::from_secs(20 * 60);

/// How many lines of a failing run come back with the summary.
const KEPT_FAILURES: usize = 40;

/// The scenario files, by the name a `run` takes.
pub fn list(repo: &Path) -> Result<Vec<String>, String> {
    let dir = repo.join("e2e");
    if !dir.is_dir() {
        return Err(format!(
            "{} has no e2e directory; the scenarios live in e2e/*.e2e.ts",
            repo.display()
        ));
    }
    let mut names = Vec::new();
    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(stem) = name.strip_suffix(".e2e.ts") {
            names.push(stem.to_string());
        }
    }
    names.sort();
    Ok(names)
}

/// `list`, rendered.
pub fn list_call(repo: &Path) -> Result<String, String> {
    let names = list(repo)?;
    let mut w = Toon::new();
    if names.is_empty() {
        w.field("scenarios", "none")
            .hint("write one as e2e/<name>.e2e.ts");
        return Ok(w.into_string());
    }
    w.inline("scenarios", &names, names.len());
    w.hint("dev_scenario action=run name=<one of these>, or no name for all of them");
    Ok(w.into_string())
}

/// What one run produced, reduced to the lines a caller acts on.
#[derive(Debug)]
pub struct RunReport {
    pub ok: bool,
    pub summary: Vec<String>,
    pub failures: Vec<String>,
    pub elapsed_ms: u128,
    pub timed_out: bool,
}

/// Run the suite, or the one scenario `name` picks.
///
/// The name goes to vitest as its own file filter rather than being turned
/// into a path here: vitest already matches a substring against the include
/// list, and a path built in Rust would be a second idea of where the files
/// are.
pub fn run(repo: &Path, name: Option<&str>) -> Result<RunReport, String> {
    if let Some(name) = name {
        let known = list(repo)?;
        if !known.iter().any(|n| n == name) {
            return Err(format!(
                "no scenario named {name}; dev_scenario action=list answers {}",
                known.join(", ")
            ));
        }
    }
    let bun = if cfg!(windows) { "bun.exe" } else { "bun" };
    let mut command = Command::new(bun);
    command.arg("run").arg("e2e");
    if let Some(name) = name {
        command.arg("--").arg(name);
    }
    command
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|e| format!("cannot run `{bun} run e2e` in {}: {e}", repo.display()))?;
    let job = Job::assign(child.id());
    let (sender, receiver) = mpsc::channel::<String>();
    read_pipe(child.stdout.take(), sender.clone());
    read_pipe(child.stderr.take(), sender);

    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => return Err(format!("cannot wait on the run: {e}")),
        }
        if started.elapsed() > RUN_DEADLINE {
            timed_out = true;
            // The pid captured at spawn, through the job object that holds the
            // whole `bun` → vitest → shim → app tree. Never a name.
            if let Some(job) = job.as_ref() {
                job.terminate();
            }
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    drop(job);

    let mut output = String::new();
    // The readers get a moment to hand over what they already have; a pipe
    // whose writer is gone ends on its own.
    std::thread::sleep(Duration::from_millis(300));
    while let Ok(part) = receiver.try_recv() {
        output.push_str(&part);
    }
    let ok = !timed_out
        && matches!(child.try_wait(), Ok(Some(status)) if status.success());
    let (summary, failures) = reduce(&output);
    Ok(RunReport {
        ok,
        summary,
        failures,
        elapsed_ms: started.elapsed().as_millis(),
        timed_out,
    })
}

/// `run`, rendered.
pub fn run_call(repo: &Path, name: Option<&str>) -> Result<String, String> {
    let report = run(repo, name)?;
    let mut w = Toon::new();
    w.field("scenario", name.unwrap_or("all"))
        .flag("passed", report.ok)
        .field("elapsedMs", &report.elapsed_ms.to_string());
    if report.timed_out {
        w.field(
            "timedOut",
            &format!("{}s; the run was stopped", RUN_DEADLINE.as_secs()),
        );
    }
    if report.summary.is_empty() {
        w.field("summary", "none");
    } else {
        w.inline("summary", &report.summary, report.summary.len());
    }
    if !report.failures.is_empty() {
        w.inline("failures", &report.failures, KEPT_FAILURES);
    }
    if !report.ok {
        w.hint("the scenario files are e2e/*.e2e.ts; a failing one names its own assertion");
    }
    Ok(w.into_string())
}

/// The vitest summary and the assertions that failed, out of the whole run.
///
/// Written as a filter over lines rather than a parse of vitest's reporter: a
/// reporter is a rendering and changes between minor versions, while the four
/// words below are what the tool promises to answer.
pub fn reduce(output: &str) -> (Vec<String>, Vec<String>) {
    let mut summary = Vec::new();
    let mut failures = Vec::new();
    for raw in output.lines() {
        let line = strip_ansi(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("Test Files")
            || trimmed.starts_with("Tests ")
            || trimmed.starts_with("Duration")
            || trimmed.starts_with("Start at")
        {
            summary.push(trimmed.to_string());
            continue;
        }
        let failed = trimmed.starts_with("FAIL")
            || trimmed.starts_with("AssertionError")
            || trimmed.starts_with("Error:")
            || trimmed.starts_with("→")
            || trimmed.starts_with("- Expected")
            || trimmed.starts_with("+ Received");
        if failed && failures.len() < KEPT_FAILURES {
            failures.push(crate::toon::clip(trimmed, 300));
        }
    }
    (summary, failures)
}

/// Drop the colour a terminal reporter writes, so a line can be matched.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

/// Read a pipe to the end on its own thread, in chunks.
///
/// The pipe has to be drained whatever happens: a vitest whose stdout fills
/// blocks, and a blocked run never finishes.
fn read_pipe<R: Read + Send + 'static>(pipe: Option<R>, into: mpsc::Sender<String>) {
    let Some(mut pipe) = pipe else { return };
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if into
                        .send(String::from_utf8_lossy(&buffer[..n]).to_string())
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
}

/// The repo's own e2e directory, for the error a caller reads first.
pub fn e2e_dir(repo: &Path) -> PathBuf {
    repo.join("e2e")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .parent()
            .and_then(|p| p.parent())
            .expect("root")
            .to_path_buf()
    }

    /// The list is the files, and the name a `run` takes is the stem without
    /// the double extension: `chat`, not `chat.e2e.ts`.
    #[test]
    fn the_scenarios_are_the_files_in_e2e() {
        let names = list(&root()).expect("listed");
        assert!(names.contains(&"boot".to_string()), "{names:?}");
        assert!(names.iter().all(|n| !n.contains(".e2e")), "{names:?}");
    }

    #[test]
    fn a_repo_with_no_e2e_directory_says_which_files_it_wanted() {
        let error = list(&std::env::temp_dir()).expect_err("refused");
        assert!(error.contains("e2e/*.e2e.ts"), "{error}");
    }

    /// A name that is not a file is refused before `bun` is spawned: the run
    /// would otherwise take twenty minutes to answer "no test files found".
    #[test]
    fn an_unknown_scenario_is_refused_with_the_list() {
        let error = run(&root(), Some("nonsense")).expect_err("refused");
        assert!(error.contains("no scenario named nonsense"), "{error}");
        assert!(error.contains("boot"), "{error}");
    }

    #[test]
    fn the_summary_lines_are_picked_out_of_a_whole_run() {
        let output = "\u{1b}[32m✓\u{1b}[39m e2e/boot.e2e.ts (2 tests) 900ms\n\
                      \n Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Duration  12.00s\n";
        let (summary, failures) = reduce(output);
        assert!(summary.iter().any(|l| l.starts_with("Test Files  1 passed")), "{summary:?}");
        assert!(summary.iter().any(|l| l.starts_with("Tests  2 passed")), "{summary:?}");
        assert!(failures.is_empty(), "{failures:?}");
    }

    #[test]
    fn a_failing_run_answers_the_assertion_rather_than_the_whole_log() {
        let output = "FAIL  e2e/chat.e2e.ts > the assistant text appears\n\
                      AssertionError: expected 'x' to contain 'ok'\n\
                      noise nobody needs\n Tests  1 failed (1)\n";
        let (summary, failures) = reduce(output);
        assert!(summary.iter().any(|l| l.contains("1 failed")), "{summary:?}");
        assert!(failures.iter().any(|l| l.starts_with("FAIL")), "{failures:?}");
        assert!(
            failures.iter().any(|l| l.contains("expected 'x' to contain 'ok'")),
            "{failures:?}"
        );
        assert!(!failures.iter().any(|l| l.contains("noise")), "{failures:?}");
    }

    #[test]
    fn the_deadline_is_the_twenty_minutes_the_tool_promises() {
        assert_eq!(RUN_DEADLINE.as_secs(), 1200);
        assert_eq!(e2e_dir(&root()), root().join("e2e"));
    }
}
