//! The isolated dev window as a process this shim owns.
//!
//! `bun run dev:isolated` is a build and then an app: vite on port 1430,
//! `tauri dev` compiling `src-tauri` in debug, and finally a "Boite Dev"
//! window under the `dev.boite.dev` identifier with its own database. Cold,
//! the cargo build alone is minutes, which is why `start` waits with a ten
//! minute deadline and why `status` distinguishes `building` from `up`.
//!
//! Two rules hold the stop, both from `AGENTS.md`:
//!
//! 1. **Only the pid captured at spawn.** Never a name, never a pattern: this
//!    worktree's path and the word "boite" are in the argv of the user's own
//!    threads and of the app drawing them.
//! 2. **The tree, not the pid.** `bun` spawns `tauri`, which spawns `cargo`,
//!    which spawns the app; killing the pid alone leaves the rest compiling.
//!    A `boite_core::job::Job` with `KILL_ON_JOB_CLOSE` holds all of it, and
//!    closing that handle is the stop.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use boite_core::job::Job;

use super::bridge::Bridge;

/// The window's title, which is `productName` in the isolated config and how
/// the bridge is told apart from any other Tauri app on this machine.
pub const DEV_WINDOW_TITLE: &str = "Boite Dev";

/// Long enough for a cold `cargo build` of `src-tauri` in debug.
pub const START_DEADLINE: Duration = Duration::from_secs(600);

/// How many of the child's output lines are kept for `status` to report.
const KEPT_LINES: usize = 40;

/// What a caller sees when it asks where the window is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Nothing spawned, or the tree has exited.
    Down,
    /// The child is alive and the window is not answering yet.
    Building,
    /// The vite port answers and the bridge accepts a connection.
    Up,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Down => "down",
            Phase::Building => "building",
            Phase::Up => "up",
        }
    }
}

/// The status machine, as a function of the three things that can be observed.
///
/// Written apart from the process so it can be tested: every combination is
/// reachable, and the one that used to be wrong is a dead child whose port is
/// still held by something else, which must read `down` rather than `up`.
pub fn phase_of(child_alive: bool, port_answers: bool, bridge_answers: bool) -> Phase {
    if !child_alive {
        return Phase::Down;
    }
    if port_answers && bridge_answers {
        Phase::Up
    } else {
        Phase::Building
    }
}

/// The dev window this shim started, or the absence of one.
pub struct DevWindow {
    repo: PathBuf,
    port: u16,
    running: Option<Running>,
}

struct Running {
    child: Child,
    pid: u32,
    started: Instant,
    /// Held for its `KILL_ON_JOB_CLOSE`: dropping it takes the tree.
    #[allow(dead_code)]
    job: Option<Job>,
    output: Arc<Mutex<Vec<String>>>,
}

impl DevWindow {
    pub fn new(repo: PathBuf, port: u16) -> Self {
        DevWindow {
            repo,
            port,
            running: None,
        }
    }

    pub fn repo(&self) -> &Path {
        &self.repo
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn pid(&self) -> Option<u32> {
        self.running.as_ref().map(|r| r.pid)
    }

    pub fn elapsed_ms(&self) -> Option<u128> {
        self.running.as_ref().map(|r| r.started.elapsed().as_millis())
    }

    /// The last lines the child printed, newest last. What `status` reports
    /// while a build is running, since that is the only progress there is.
    pub fn recent_output(&self) -> Vec<String> {
        self.running
            .as_ref()
            .and_then(|r| r.output.lock().ok().map(|lines| lines.clone()))
            .unwrap_or_default()
    }

    pub fn phase(&mut self) -> Phase {
        let alive = self.child_alive();
        if !alive {
            return Phase::Down;
        }
        let port_answers = port_answers(self.port);
        let bridge_answers = port_answers && Bridge::discover(DEV_WINDOW_TITLE).is_ok();
        phase_of(alive, port_answers, bridge_answers)
    }

    /// Whether the tree this shim spawned is still running.
    ///
    /// `try_wait` on the pid captured at spawn, never a scan for a name.
    fn child_alive(&mut self) -> bool {
        match self.running.as_mut() {
            Some(running) => matches!(running.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Wipe the dev instance's database before a start.
    ///
    /// `dev.boite.dev` only, ever. The identifier is a constant in
    /// [`super::paths`] and is never taken from an argument, so no call from
    /// an agent can point this at `com.boite.desktop`.
    pub fn wipe_database(&self) -> Result<Vec<String>, String> {
        let db = super::paths::dev_database()?;
        let mut removed = Vec::new();
        for suffix in ["", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", db.display()));
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("cannot wipe {}: {e}", path.display()))?;
                removed.push(path.display().to_string());
            }
        }
        Ok(removed)
    }

    /// Spawn `bun run dev:isolated` and wait until the window answers.
    ///
    /// `env` is merged onto the inherited environment, which is how a later
    /// scenario run hands the app `BOITE_PILOT_CLAUDE_BIN` and
    /// `BOITE_PILOT_SCENARIO`. `BOITE_DEV_UNATTENDED` is always set: the
    /// machine belongs to somebody who is working on it, and a window that
    /// takes the keyboard mid-sentence is the one failure this tool must not
    /// have.
    pub fn start(&mut self, env: &BTreeMap<String, String>) -> Result<StartReport, String> {
        if self.child_alive() {
            return Err("the dev window is already running; stop it or use restart".into());
        }
        let bun = if cfg!(windows) { "bun.exe" } else { "bun" };
        let mut command = Command::new(bun);
        command
            .arg("run")
            .arg("dev:isolated")
            .current_dir(&self.repo)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.env("BOITE_DEV_UNATTENDED", "1");
        for (key, value) in env {
            command.env(key, value);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: the build is long and a console flashing up in
            // front of whoever is using the machine is the same interruption
            // as stealing focus.
            command.creation_flags(0x0800_0000);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("cannot run `{bun} run dev:isolated` in {}: {e}", self.repo.display()))?;
        let pid = child.id();
        let job = Job::assign(pid);
        let output = Arc::new(Mutex::new(Vec::new()));
        drain(child.stdout.take(), Arc::clone(&output));
        drain(child.stderr.take(), Arc::clone(&output));
        let started = Instant::now();
        self.running = Some(Running {
            child,
            pid,
            started,
            job,
            output: Arc::clone(&output),
        });

        tracing::info!(pid, port = self.port, "devmcp.window.spawned");
        let report = self.wait_until_up(started)?;
        Ok(report)
    }

    /// Poll until the vite port and the bridge both answer, or give up.
    ///
    /// A child that exits during the wait ends it at once with the tail of
    /// what it printed: that is where the compile error is, and waiting the
    /// remaining nine minutes for a process that is gone helps nobody.
    fn wait_until_up(&mut self, started: Instant) -> Result<StartReport, String> {
        let mut port_seen_at: Option<Duration> = None;
        loop {
            if !self.child_alive() {
                let tail = self.recent_output().join("\n");
                self.running = None;
                return Err(format!("`bun run dev:isolated` exited before the window came up:\n{tail}"));
            }
            if port_seen_at.is_none() && port_answers(self.port) {
                port_seen_at = Some(started.elapsed());
            }
            if port_seen_at.is_some() {
                if let Ok(bridge) = Bridge::discover(DEV_WINDOW_TITLE) {
                    return Ok(StartReport {
                        pid: self.pid().unwrap_or(0),
                        bridge_port: bridge.port(),
                        vite_ms: port_seen_at.unwrap_or_default().as_millis(),
                        total_ms: started.elapsed().as_millis(),
                    });
                }
            }
            if started.elapsed() > START_DEADLINE {
                let tail = self.recent_output().join("\n");
                return Err(format!(
                    "the dev window did not come up within {}s; it is still running as pid {} and stop will take it:\n{tail}",
                    START_DEADLINE.as_secs(),
                    self.pid().unwrap_or(0)
                ));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// Close the job object, and nothing else.
    ///
    /// `KILL_ON_JOB_CLOSE` means the drop is already the kill;
    /// `TerminateJobObject` first so the wait below has something to reap.
    /// No pid this shim did not spawn is touched, and no name is matched.
    pub fn stop(&mut self) -> StopReport {
        let Some(mut running) = self.running.take() else {
            return StopReport {
                pid: None,
                survived: false,
            };
        };
        if let Some(job) = running.job.as_ref() {
            job.terminate();
        }
        // The handle drops with `running`, which is the second half of the
        // stop on a machine where TerminateJobObject failed.
        drop(running.job.take());
        let survived = match running.child.try_wait() {
            Ok(Some(_)) => false,
            _ => match wait_for_exit(&mut running.child, Duration::from_secs(5)) {
                true => false,
                false => true,
            },
        };
        tracing::info!(pid = running.pid, survived, "devmcp.window.stopped");
        StopReport {
            pid: Some(running.pid),
            survived,
        }
    }
}

impl Drop for DevWindow {
    fn drop(&mut self) {
        // A shim that exits must not leave a build running. The job handle
        // closing is the kill; there is nothing else to do here.
        self.stop();
    }
}

pub struct StartReport {
    pub pid: u32,
    pub bridge_port: u16,
    pub vite_ms: u128,
    pub total_ms: u128,
}

pub struct StopReport {
    pub pid: Option<u32>,
    pub survived: bool,
}

/// Whether something accepts a connection on loopback at `port`.
///
/// **Both loopback families, and this is not defensive.** Vite binds `::1`
/// alone on Windows, so a probe of `127.0.0.1` never sees it: the window came
/// up, the bridge answered, and `start` waited out its ten minutes on a port
/// that had been listening the whole time. The bridge itself is the other way
/// round, the plugin taking the literal `127.0.0.1` boite passes it, so a
/// probe of one family only is wrong for one of the two whichever family it
/// picks.
pub fn port_answers(port: u16) -> bool {
    for host in ["127.0.0.1", "[::1]"] {
        let Ok(addr) = format!("{host}:{port}").parse() else {
            continue;
        };
        if let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
            let _ = stream.shutdown(Shutdown::Both);
            return true;
        }
    }
    false
}

fn wait_for_exit(child: &mut Child, patience: Duration) -> bool {
    let deadline = Instant::now() + patience;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    matches!(child.try_wait(), Ok(Some(_)))
}

/// Keep the last [`KEPT_LINES`] lines of a pipe, and let the rest go.
///
/// The pipe has to be drained whatever happens: a `tauri dev` whose stdout
/// fills blocks, and a blocked build never comes up.
fn drain<R: std::io::Read + Send + 'static>(pipe: Option<R>, into: Arc<Mutex<Vec<String>>>) {
    let Some(pipe) = pipe else { return };
    std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines() {
            let Ok(line) = line else { break };
            if let Ok(mut kept) = into.lock() {
                kept.push(line);
                if kept.len() > KEPT_LINES {
                    let excess = kept.len() - KEPT_LINES;
                    kept.drain(..excess);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_child_is_down_whatever_the_ports_say() {
        assert_eq!(phase_of(false, false, false), Phase::Down);
        // The case that used to read `up`: the child is gone and something
        // else, an older window or a stale vite, still holds the ports.
        assert_eq!(phase_of(false, true, true), Phase::Down);
    }

    #[test]
    fn a_live_child_with_no_window_yet_is_building() {
        assert_eq!(phase_of(true, false, false), Phase::Building);
        // vite comes up minutes before the app does, so the port alone is not
        // the window.
        assert_eq!(phase_of(true, true, false), Phase::Building);
    }

    #[test]
    fn up_needs_both_the_port_and_the_bridge() {
        assert_eq!(phase_of(true, true, true), Phase::Up);
        assert_eq!(phase_of(true, false, true), Phase::Building);
    }

    #[test]
    fn the_phases_name_themselves_the_way_the_tool_reports_them() {
        assert_eq!(Phase::Down.as_str(), "down");
        assert_eq!(Phase::Building.as_str(), "building");
        assert_eq!(Phase::Up.as_str(), "up");
    }

    #[test]
    fn nothing_answers_on_a_port_nothing_is_bound_to() {
        // Port 1 needs privileges nothing in this test has, so a listener
        // cannot appear underneath the assertion.
        assert!(!port_answers(1));
    }
}
