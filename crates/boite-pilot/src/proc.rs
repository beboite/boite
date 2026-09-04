//! Spawning agent children, and taking them back.
//!
//! A pilot child is not a PTY: it is a plain process with three pipes. What it
//! shares with `boite_core::pty` is the two rules that matter on Windows, and
//! both are re-stated here rather than imported, `boite-core` carrying no async
//! runtime and this crate no `PtyManager`:
//!
//! 1. **The tree dies with the session.** A job object with
//!    `KILL_ON_JOB_CLOSE` holds the child and everything it spawns, so a boite
//!    killed without cleanup still leaves nothing behind.
//! 2. **Only a pid captured at spawn is ever killed.** Never a name, never a
//!    pattern: this worktree's path and the word "boite" are in the argv of the
//!    user's own threads and of the app drawing them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child as TokioChild, ChildStdin, Command};
use tokio::sync::mpsc;

use crate::driver::{Instance, PilotError};

/// How long a child gets to leave on its own once its stdin is closed.
///
/// The same 1.5s `PtyManager::kill` gives a PTY child, and for the same reason:
/// claude writes a `fullscreenBootPending` record at launch and clears it from
/// its exit hook, and two skipped hooks turn its fullscreen renderer off.
pub const GRACE: Duration = Duration::from_millis(1500);

/// Build the argv for a fastpick-routed launch.
///
/// fastpick resolves a harness and then runs it, so everything the agent itself
/// takes goes behind the `--` separator. Appending to one flat list holds only
/// until an agent flag collides with a name fastpick claims, which is the same
/// trap `thread/resume-args.ts` documents for the terminal runtime.
pub fn fastpick_argv(harness: &str, provider: &str, model: &str, inner: &[String]) -> Vec<String> {
    let mut argv = vec![
        "fastpick".to_string(),
        "--harness".to_string(),
        harness.to_string(),
        "--provider".to_string(),
        provider.to_string(),
        "--model".to_string(),
        model.to_string(),
        "--".to_string(),
    ];
    argv.extend(inner.iter().cloned());
    argv
}

/// Wrap `inner` for the instance it runs on: a fastpick route becomes a
/// fastpick launch, a native instance runs as it is.
pub fn argv_for_instance(harness: &str, instance: &Instance, inner: Vec<String>) -> Vec<String> {
    match instance {
        Instance::Native { .. } => inner,
        Instance::Fastpick { provider, model } => {
            fastpick_argv(harness, provider, model, &inner)
        }
    }
}

/// A spawned agent process, its pid captured and its stdio piped.
pub struct Child {
    pid: Option<u32>,
    child: Option<TokioChild>,
    stdin: Option<ChildStdin>,
    #[cfg(target_os = "windows")]
    job: Option<job::Job>,
}

/// One line the child printed, tagged with which pipe it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    Out(String),
    Err(String),
    /// Both pipes reached EOF.
    Eof,
}

impl Child {
    /// Spawn `argv` in `cwd` with `env` merged onto the inherited environment.
    ///
    /// Returns the child and a channel of its output lines. The reader tasks
    /// own the pipes, so nothing else has to poll them.
    pub fn spawn(
        argv: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Line>), PilotError> {
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| PilotError::Spawn("empty argv".to_string()))?;

        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        for (key, value) in env {
            command.env(key, value);
        }

        let mut child = command
            .spawn()
            .map_err(|error| PilotError::Spawn(format!("{program}: {error}")))?;
        let pid = child.id();

        #[cfg(target_os = "windows")]
        let job = pid.and_then(job::Job::assign);

        let (tx, rx) = mpsc::unbounded_channel();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();

        // Two readers and a joiner: the consumer wants one `Eof` after both
        // pipes close, not one per pipe, because a driver ends its session on
        // that edge.
        let (done_tx, mut done_rx) = mpsc::unbounded_channel::<()>();
        if let Some(stdout) = stdout {
            let tx = tx.clone();
            let done = done_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tx.send(Line::Out(line)).is_err() {
                        break;
                    }
                }
                let _ = done.send(());
            });
        } else {
            let _ = done_tx.send(());
        }
        if let Some(stderr) = stderr {
            let tx = tx.clone();
            let done = done_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if tx.send(Line::Err(line)).is_err() {
                        break;
                    }
                }
                let _ = done.send(());
            });
        } else {
            let _ = done_tx.send(());
        }
        drop(done_tx);
        tokio::spawn(async move {
            let mut seen = 0;
            while done_rx.recv().await.is_some() {
                seen += 1;
                if seen == 2 {
                    break;
                }
            }
            let _ = tx.send(Line::Eof);
        });

        tracing::info!(pid = ?pid, program = %program, "pilot.child.spawned");
        Ok((
            Self {
                pid,
                child: Some(child),
                stdin,
                #[cfg(target_os = "windows")]
                job,
            },
            rx,
        ))
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Write one JSON line on the child's stdin.
    pub async fn write_line(&mut self, line: &str) -> Result<(), PilotError> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| PilotError::SessionGone("stdin is closed".to_string()))?;
        stdin.write_all(line.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Close stdin. Every agent CLI here ends its turn loop on that EOF, so it
    /// is the polite half of the stop.
    pub fn close_stdin(&mut self) {
        self.stdin = None;
    }

    /// Polite stop, then the pid captured at spawn and nothing else.
    ///
    /// stdin closes first, the child gets `GRACE` to run its own exit path, and
    /// only then is the tree taken. Returns whether the child left on its own.
    pub async fn stop(&mut self) -> bool {
        self.close_stdin();
        let Some(mut child) = self.child.take() else {
            return true;
        };
        if let Ok(Ok(_)) = tokio::time::timeout(GRACE, child.wait()).await {
            tracing::info!(pid = ?self.pid, "pilot.child.left");
            return true;
        }

        #[cfg(target_os = "windows")]
        {
            // TerminateJobObject takes the whole tree in one syscall. The job
            // holds this pid alone, so nothing else can be in it.
            if let Some(job) = self.job.as_ref() {
                if job.terminate() {
                    let _ = child.wait().await;
                    tracing::warn!(pid = ?self.pid, "pilot.child.killed");
                    return false;
                }
            }
        }
        // `Child::kill` sends SIGKILL on unix and TerminateProcess on Windows,
        // both against the handle this struct opened at spawn.
        let _ = child.kill().await;
        tracing::warn!(pid = ?self.pid, "pilot.child.killed");
        false
    }

    /// Whether the child has already exited, without blocking.
    pub fn exit_code(&mut self) -> Option<i32> {
        let child = self.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
            _ => None,
        }
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        // A dropped session must not leave a tree running. On Windows the job
        // handle closing is enough (KILL_ON_JOB_CLOSE); elsewhere the pid we
        // captured is killed directly.
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

/// Resolve the binary for a driver: an explicit argv wins, then the env
/// override a test or the dev MCP sets, then the default name on the PATH.
pub fn resolve_bin(explicit: &[String], env_var: &str, default: &str) -> Vec<String> {
    if !explicit.is_empty() {
        return explicit.to_vec();
    }
    match std::env::var(env_var) {
        Ok(value) if !value.trim().is_empty() => split_bin(&value),
        _ => vec![default.to_string()],
    }
}

/// Split an env-provided binary into an argv.
///
/// A `.mjs` fake is not executable on Windows, so the variable is allowed to
/// carry `node C:\path\to\fake-claude.mjs`. Quotes keep a path with spaces in
/// one piece; nothing else is interpreted, this being a launcher and not a
/// shell.
fn split_bin(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in value.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    if out.is_empty() {
        out.push(value.to_string());
    }
    out
}

/// The directory a config-dir instance points at, if any.
pub fn config_dir(instance: &Instance) -> Option<PathBuf> {
    match instance {
        Instance::Native { config_dir } => config_dir.clone(),
        Instance::Fastpick { .. } => None,
    }
}

#[cfg(target_os = "windows")]
mod job {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub struct Job(HANDLE);

    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn assign(pid: u32) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    CloseHandle(job);
                    return None;
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    CloseHandle(job);
                    return None;
                }
                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Self(job))
            }
        }

        pub fn terminate(&self) -> bool {
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fastpick_route_puts_the_agent_behind_the_separator() {
        let inner = vec![
            "claude".to_string(),
            "--print".to_string(),
            "--model".to_string(),
            "sonnet".to_string(),
        ];
        let argv = fastpick_argv("claude", "openrouter", "glm-5", &inner);
        assert_eq!(
            argv,
            vec![
                "fastpick",
                "--harness",
                "claude",
                "--provider",
                "openrouter",
                "--model",
                "glm-5",
                "--",
                "claude",
                "--print",
                "--model",
                "sonnet",
            ]
        );
        let separator = argv.iter().position(|a| a == "--").expect("separator");
        assert!(
            argv[..separator].iter().all(|a| a != "--print"),
            "an agent flag in front of the separator is fastpick's to parse"
        );
    }

    #[test]
    fn a_native_instance_launches_the_agent_directly() {
        let inner = vec!["claude".to_string(), "--print".to_string()];
        let argv = argv_for_instance("claude", &Instance::Native { config_dir: None }, inner.clone());
        assert_eq!(argv, inner);
    }

    #[test]
    fn an_env_binary_may_carry_its_interpreter() {
        assert_eq!(split_bin("claude"), vec!["claude"]);
        assert_eq!(
            split_bin("node \"C:\\a b\\fake-claude.mjs\""),
            vec!["node", "C:\\a b\\fake-claude.mjs"]
        );
    }

    #[test]
    fn an_explicit_argv_outranks_the_env_override() {
        let explicit = vec!["node".to_string(), "fake.mjs".to_string()];
        assert_eq!(resolve_bin(&explicit, "BOITE_PILOT_NOPE", "claude"), explicit);
        assert_eq!(resolve_bin(&[], "BOITE_PILOT_NOPE", "claude"), vec!["claude"]);
    }
}
