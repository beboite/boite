use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{SyncSender, TrySendError};

// Chunks of pending input per PTY. Deep enough to swallow a large paste split
// across IPC messages, shallow enough that a stalled child cannot be used to
// grow the process indefinitely.
const WRITE_QUEUE_DEPTH: usize = 1024;

use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vte::{Params, Parser, Perform};

/// What the emulator on the other end is, stated rather than inherited.
///
/// A desktop app started from Finder or the Dock gets launchd's environment,
/// which carries no TERM at all, and nothing downstream supplies one: neither
/// this crate nor portable-pty. A shell whose terminfo is unknown loses line
/// editing — zsh answers a backspace with a bare space instead of the
/// backspace/space/backspace dance, so the deleted character stays on screen
/// while the buffer behind it is correct. Agent CLIs escape it by driving the
/// terminal in raw mode, which is why plain shells were the only ones bitten.
///
/// Inherited values are overridden on purpose: whatever launched the app says
/// nothing about the terminal we actually render into, which is xterm.js.
pub fn terminal_env_defaults() -> [(&'static str, &'static str); 2] {
    [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")]
}

// Raw, transport-agnostic PTY event. The host adapter decides how to encode
// it on the wire: the Tauri desktop adapter base64-encodes Output into its
// IPC Channel; the server pushes raw bytes into a ring buffer + WS frame.
#[derive(Clone, Debug)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Title(String),
    Exit(Option<i32>),
    Error(String),
}

// Output destination for one PTY. `send` returns false when the sink is
// permanently closed so the reader loop can stop (desktop: the IPC channel
// died with the webview). A server sink that buffers scrollback returns true
// forever, so the PTY survives every client disconnect.
pub trait EventSink: Send + Sync + 'static {
    fn send(&self, event: PtyEvent) -> bool;
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnArgs {
    pub cwd: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub env: Option<HashMap<String, String>>,
    /// Shell the command may be run inside, when it turns out to need one.
    /// Whether it does is decided here, not by the caller: only the machine
    /// that owns the PTY knows its own PATH and its own shell profile, and for
    /// a remote boite that machine is the server.
    #[serde(default)]
    pub wrap: Option<WrapSpec>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WrapSpec {
    pub shell_id: String,
    #[serde(default)]
    pub no_profile: bool,
}

/// What one run of the shell tells us about itself.
#[derive(Default)]
struct ShellProbe {
    /// Names it resolves ahead of the PATH: its functions and aliases.
    names: HashSet<String>,
    /// Variables its profile exports that this process does not have. A
    /// shortcut spawned directly never sources that profile, and losing an
    /// export the user set there is the kind of difference that shows up much
    /// later as a tool behaving differently inside boite than in a terminal.
    env: HashMap<String, String>,
}

/// Asks a shell for the names it defines itself. Runs to completion once per
/// shell per session, off the spawn path.
fn probe_shell_names(shell_id: &str) -> Option<ShellProbe> {
    let shell = crate::shell::available_shells_blocking()
        .into_iter()
        .find(|s| s.id == shell_id)?;
    let probe = crate::shell::names_probe_argv(&shell.cmd)?;
    let mut cmd = std::process::Command::new(&shell.cmd);
    cmd.args(shell.args.iter().chain(probe.iter()));
    // No console window, and no stdin: an interactive shell that finds a
    // closed stdin gives up instead of waiting for a prompt that never comes.
    cmd.stdin(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_probe_output(
        &String::from_utf8_lossy(&out.stdout),
        |key| std::env::var_os(key).is_some(),
    ))
}

/// Splits the probe's two halves. `already_set` decides which variables are
/// worth keeping: only the ones the host process does not already define, so
/// what survives is exactly what the profile adds.
fn parse_probe_output(text: &str, already_set: impl Fn(&str) -> bool) -> ShellProbe {
    let (name_part, env_part) = text
        .split_once(crate::shell::PROBE_SEPARATOR)
        .unwrap_or((text, ""));
    let names = name_part
        .lines()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .collect();
    let mut env = HashMap::new();
    for line in env_part.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        // Overwriting a variable the process already has would hand the spawn a
        // stale copy of something the app itself set up, and TERM in particular
        // is ours to state.
        if key.is_empty() || already_set(key) {
            continue;
        }
        env.insert(key.to_string(), value.trim_end_matches(['\r', '\n']).to_string());
    }
    ShellProbe { names, env }
}

// Each child is assigned to a Windows Job object with KILL_ON_JOB_CLOSE:
// TerminateJobObject kills the whole process tree in one syscall (the
// taskkill shell-out it replaces took 0.5-2s per PTY and stalled app close),
// and if boite dies without cleanup the OS closes the handle and reaps the
// tree anyway.
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

struct PtyHandle {
    // Option so kill() can drop the master while the reader thread still owns
    // the map entry: on Windows, ConPTY read() never returns EOF after the
    // child dies until ClosePseudoConsole runs (which happens when the master
    // is dropped). Without this, kill(wait=true) spends its full 5s timeout
    // on every reload.
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    // Writes go through a dedicated thread per PTY. A blocking write_all on
    // the IPC thread froze the whole UI whenever the child stopped draining
    // (big paste, suspended process, full ConPTY buffer).
    writer_tx: SyncSender<Vec<u8>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    pid: Option<u32>,
    #[cfg(target_os = "windows")]
    job: Option<Arc<job::Job>>,
}

#[derive(Clone, Default)]
pub struct PtyManager {
    inner: Arc<Mutex<HashMap<String, PtyHandle>>>,
    // which() walks the full PATH x PATHEXT synchronously; memoize hits so
    // respawns don't pay it again. Misses are not cached so a tool installed
    // mid-session resolves on the next spawn.
    which_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
    // Names each shell resolves ahead of the PATH: its functions and aliases.
    // Filled by a background probe (~300ms for PowerShell) so no spawn ever
    // waits on it; until it lands, the PATH alone decides.
    shell_names: Arc<Mutex<HashMap<String, Arc<ShellProbe>>>>,
    probing: Arc<Mutex<HashSet<String>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts the shell probe for `shell_id` if it has not run yet.
    /// Fire and forget: callers get no result and never block.
    pub fn warm_shell_names(&self, shell_id: &str) {
        if self.shell_names.lock().contains_key(shell_id) {
            return;
        }
        if !self.probing.lock().insert(shell_id.to_string()) {
            return;
        }
        let id = shell_id.to_string();
        let names = self.shell_names.clone();
        let probing = self.probing.clone();
        std::thread::spawn(move || {
            let found = probe_shell_names(&id).unwrap_or_default();
            names.lock().insert(id.clone(), Arc::new(found));
            probing.lock().remove(&id);
        });
    }

    fn is_on_path(&self, cmd: &str) -> bool {
        if self.which_cache.lock().contains_key(cmd) {
            return true;
        }
        match which::which(cmd) {
            Ok(path) => {
                self.which_cache.lock().insert(cmd.to_string(), path);
                true
            }
            Err(_) => false,
        }
    }

    /// Decides whether `cmd` has to go through the shell, and returns the argv
    /// that does it. `None` means spawn it directly.
    fn wrap_plan(&self, spec: &PtySpawnArgs) -> Option<(String, Vec<String>)> {
        let wrap = spec.wrap.as_ref()?;
        // A shell defining the name wins over a binary of the same name: that
        // is the resolution order the user sees at their own prompt. Falling
        // back to the PATH check alone keeps the very first spawn correct for
        // the case that actually matters, a name no binary provides.
        let shadowed = self
            .shell_names
            .lock()
            .get(&wrap.shell_id)
            .map(|probe| probe.names.contains(&spec.cmd));
        let needs_shell = match shadowed {
            Some(true) => true,
            Some(false) | None => !self.is_on_path(&spec.cmd),
        };
        if !needs_shell {
            return None;
        }
        let shell = crate::shell::available_shells_blocking()
            .into_iter()
            .find(|s| s.id == wrap.shell_id)?;
        let argv = crate::shell::wrap_argv(
            &shell.cmd,
            &shell.args,
            wrap.no_profile,
            &spec.cmd,
            &spec.args,
        )?;
        Some((shell.cmd, argv))
    }

    /// Exports the shell's profile adds that this process is missing. Only
    /// meaningful for a direct spawn: a wrapped one sources the profile itself.
    fn profile_env(&self, spec: &PtySpawnArgs) -> HashMap<String, String> {
        let Some(wrap) = spec.wrap.as_ref() else {
            return HashMap::new();
        };
        self.shell_names
            .lock()
            .get(&wrap.shell_id)
            .map(|probe| probe.env.clone())
            .unwrap_or_default()
    }

    fn resolve_cmd(&self, cmd: &str) -> String {
        if let Some(hit) = self.which_cache.lock().get(cmd) {
            return hit.to_string_lossy().into_owned();
        }
        match which::which(cmd) {
            Ok(path) => {
                let resolved = path.to_string_lossy().into_owned();
                self.which_cache.lock().insert(cmd.to_string(), path);
                resolved
            }
            Err(_) => cmd.to_string(),
        }
    }

    pub fn spawn(
        &self,
        sink: Arc<dyn EventSink>,
        spec: PtySpawnArgs,
    ) -> Result<String, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: spec.rows.max(1),
                cols: spec.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;

        let (base_cmd, base_args) = match self.wrap_plan(&spec) {
            Some(plan) => plan,
            None => (spec.cmd.clone(), spec.args.clone()),
        };

        let resolved_cmd = self.resolve_cmd(&base_cmd);
        let mut command = CommandBuilder::new(&resolved_cmd);
        command.cwd(&spec.cwd);
        // The shell picker carries login args of its own; the "default shell"
        // path only knows a binary, so log it in here rather than leaving that
        // thread with a half-initialized PATH.
        let login_args = if base_args.is_empty() {
            crate::shell::login_args_for(&resolved_cmd)
        } else {
            Vec::new()
        };
        for arg in base_args.iter().chain(login_args.iter()) {
            command.arg(arg);
        }
        // First, so both the terminal defaults and the caller still win over
        // it: a profile that exports TERM does not get to tell xterm.js what
        // it is.
        for (k, v) in self.profile_env(&spec) {
            command.env(k, v);
        }
        // Before the caller's own env, so a spec that sets TERM still wins.
        for (k, v) in terminal_env_defaults() {
            command.env(k, v);
        }
        if let Some(env) = &spec.env {
            for (k, v) in env {
                command.env(k, v);
            }
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("spawn failed: {e}"))?;
        // The slave is no longer needed in the parent; drop it after spawn.
        drop(pair.slave);

        let killer = child.clone_killer();

        let id = Uuid::new_v4().to_string();

        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone_reader failed: {e}"))?;

        // Bounded: an unbounded queue here means a child that stopped draining
        // (suspended, full ConPTY buffer) lets a client grow it without limit.
        // The depth only has to absorb a paste burst; write() reports back
        // pressure instead of buffering the world.
        let (writer_tx, writer_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(WRITE_QUEUE_DEPTH);
        std::thread::spawn(move || {
            while let Ok(data) = writer_rx.recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        let master_arc: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>> =
            Arc::new(Mutex::new(Some(pair.master)));
        let killer_arc: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>> =
            Arc::new(Mutex::new(killer));
        let pid = child.process_id();

        let handle = PtyHandle {
            master: master_arc,
            writer_tx,
            killer: killer_arc,
            pid,
            #[cfg(target_os = "windows")]
            job: pid.and_then(job::Job::assign).map(Arc::new),
        };

        self.inner.lock().insert(id.clone(), handle);

        // Reader loop: forward bytes + parse OSC titles. Owns the child, calls wait() at EOF.
        // Removing the handle from the map drops writer_tx, which ends the writer thread.
        let inner_clone = self.inner.clone();
        let id_clone = id.clone();
        let sink_clone = sink.clone();
        std::thread::spawn(move || {
            read_loop(reader, sink_clone.clone());
            let exit_code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            inner_clone.lock().remove(&id_clone);
            sink_clone.send(PtyEvent::Exit(Some(exit_code)));
        });

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let tx = {
            let map = self.inner.lock();
            let handle = map.get(id).ok_or_else(|| "pty not found".to_string())?;
            handle.writer_tx.clone()
        };
        // try_send, never send: blocking here would re-introduce the UI freeze
        // the writer thread exists to prevent. A full queue means the child is
        // not reading, so the caller is told rather than parked.
        tx.try_send(data.to_vec()).map_err(|e| match e {
            TrySendError::Full(_) => "pty write queue full: process not reading".to_string(),
            TrySendError::Disconnected(_) => "pty writer closed".to_string(),
        })
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let master = {
            let map = self.inner.lock();
            let handle = map.get(id).ok_or_else(|| "pty not found".to_string())?;
            handle.master.clone()
        };
        let guard = master.lock();
        let Some(master) = guard.as_ref() else {
            return Err("pty closing".to_string());
        };
        master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))?;
        Ok(())
    }

    // Is this PTY still tracked (reader alive, child not yet reaped)? Used by
    // the desktop adapter to decide reattach-vs-spawn for a detached session.
    pub fn is_alive(&self, id: &str) -> bool {
        self.inner.lock().contains_key(id)
    }

    // The process this PTY spawned. Used to tell a thread's own agent apart
    // from one running elsewhere: claude registers every session it holds
    // open, and the two are otherwise indistinguishable from the registry.
    // None when the PTY is gone, and when the platform never reported a pid.
    pub fn child_pid(&self, id: &str) -> Option<u32> {
        self.inner.lock().get(id).and_then(|h| h.pid)
    }

    pub fn kill_all(&self) {
        // Parallel; each kill is one TerminateJobObject syscall, the join
        // only matters for the rare taskkill fallback.
        let ids: Vec<String> = self.inner.lock().keys().cloned().collect();
        let joins: Vec<_> = ids
            .into_iter()
            .map(|id| {
                let manager = self.clone();
                std::thread::spawn(move || {
                    let _ = manager.kill(&id, false);
                })
            })
            .collect();
        for join in joins {
            let _ = join.join();
        }
    }

    pub fn kill(&self, id: &str, wait: bool) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            let (killer, pid, job, master) = {
                let map = self.inner.lock();
                match map.get(id) {
                    Some(handle) => (
                        handle.killer.clone(),
                        handle.pid,
                        handle.job.clone(),
                        handle.master.clone(),
                    ),
                    None => return Ok(()),
                }
            };
            let tree_killed = job.map(|j| j.terminate()).unwrap_or(false);
            if !tree_killed {
                if let Some(pid) = pid {
                    force_kill_process_tree(pid);
                }
            }
            let _ = killer.lock().kill();
            // Drop the master to close the pseudoconsole, otherwise the
            // reader thread stays blocked in read() forever and the wait
            // loop below burns its whole 5s deadline.
            drop(master.lock().take());
        }
        #[cfg(not(target_os = "windows"))]
        {
            let (killer, master, pid) = {
                let map = self.inner.lock();
                match map.get(id) {
                    Some(handle) => {
                        (handle.killer.clone(), handle.master.clone(), handle.pid)
                    }
                    None => return Ok(()),
                }
            };
            // portable-pty setsid()s the child, so it leads its own process
            // group (pgid == pid). Signal the whole group: killer.kill() only
            // reaps the direct shell, orphaning claude and its descendants.
            if let Some(pid) = pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = killer.lock().kill();
            drop(master.lock().take());
        }
        if !wait {
            return Ok(());
        }
        // Wait for the reader thread to clean up after child.wait() returns,
        // so the caller can safely spawn a fresh PTY without the previous
        // process still being alive (e.g. two Claude `--resume <session>`
        // racing on the same session file).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if !self.inner.lock().contains_key(id) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Err("pty kill timed out: process may still be alive".into())
    }
}

#[cfg(target_os = "windows")]
fn force_kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let pid_arg = pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", pid_arg.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
}

fn read_loop(mut reader: Box<dyn Read + Send>, sink: Arc<dyn EventSink>) {
    let mut parser = Parser::new();
    let mut osc = OscPerform { sink: sink.clone() };
    let mut buf = [0u8; 65536];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if !sink.send(PtyEvent::Output(buf[..n].to_vec())) {
                    eprintln!("[boite/pty] output sink closed");
                    break;
                }
                for byte in &buf[..n] {
                    parser.advance(&mut osc, *byte);
                }
            }
            Err(_) => break,
        }
    }
}

struct OscPerform {
    sink: Arc<dyn EventSink>,
}

impl Perform for OscPerform {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.len() < 2 {
            return;
        }
        // OSC 0/1/2 set window title (and icon name).
        let kind = params[0];
        if !(kind == b"0" || kind == b"1" || kind == b"2") {
            return;
        }
        let Ok(title) = std::str::from_utf8(params[1]) else {
            return;
        };
        self.sink.send(PtyEvent::Title(title.to_string()));
    }

    fn print(&mut self, _: char) {}
    fn execute(&mut self, _: u8) {}
    fn hook(&mut self, _: &Params, _: &[u8], _: bool, _: char) {}
    fn put(&mut self, _: u8) {}
    fn unhook(&mut self) {}
    fn csi_dispatch(&mut self, _: &Params, _: &[u8], _: bool, _: char) {}
    fn esc_dispatch(&mut self, _: &[u8], _: bool, _: u8) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_defaults_describe_xterm_js() {
        let env: HashMap<_, _> = terminal_env_defaults().into_iter().collect();
        // xterm.js speaks xterm-256color; anything else and the shell redraws
        // line edits with capabilities the emulator does not implement.
        assert_eq!(env.get("TERM"), Some(&"xterm-256color"));
        assert_eq!(env.get("COLORTERM"), Some(&"truecolor"));
    }

    fn spec(cmd: &str, wrap: Option<&str>) -> PtySpawnArgs {
        PtySpawnArgs {
            cwd: ".".into(),
            cmd: cmd.into(),
            args: vec![],
            cols: 80,
            rows: 24,
            env: None,
            wrap: wrap.map(|shell_id| WrapSpec {
                shell_id: shell_id.into(),
                no_profile: false,
            }),
        }
    }

    fn a_shell() -> Option<String> {
        crate::shell::available_shells_blocking()
            .into_iter()
            .find(|s| crate::shell::names_probe_argv(&s.cmd).is_some())
            .map(|s| s.id)
    }

    #[test]
    fn no_shell_offered_means_no_shell_used() {
        let m = PtyManager::new();
        assert!(m.wrap_plan(&spec("definitely-not-on-path-42", None)).is_none());
    }

    #[test]
    fn a_command_on_the_path_is_spawned_directly() {
        let Some(shell) = a_shell() else { return };
        let m = PtyManager::new();
        // The interpreter running this test is on the PATH by construction.
        let on_path = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(m.wrap_plan(&spec(on_path, Some(&shell))).is_none());
    }

    #[test]
    fn a_command_the_path_cannot_provide_goes_through_the_shell() {
        let Some(shell) = a_shell() else { return };
        let m = PtyManager::new();
        let (cmd, args) = m
            .wrap_plan(&spec("boite-not-a-real-binary-42", Some(&shell)))
            .expect("a name no binary provides has to be tried in the shell");
        assert!(!cmd.is_empty());
        assert!(args.iter().any(|a| a.contains("boite-not-a-real-binary-42")));
    }

    #[test]
    fn a_function_wins_over_a_binary_of_the_same_name() {
        let Some(shell) = a_shell() else { return };
        let m = PtyManager::new();
        let shadowed = if cfg!(windows) { "cmd" } else { "sh" };
        // Direct until the probe lands...
        assert!(m.wrap_plan(&spec(shadowed, Some(&shell))).is_none());
        // ...and through the shell once it reports the name as one of its own,
        // which is the order the user gets at their own prompt.
        m.shell_names.lock().insert(
            shell.clone(),
            Arc::new(ShellProbe { names: HashSet::from([shadowed.to_string()]), ..Default::default() }),
        );
        assert!(m.wrap_plan(&spec(shadowed, Some(&shell))).is_some());
    }

    struct Collector(Arc<Mutex<Vec<u8>>>);
    impl EventSink for Collector {
        fn send(&self, event: PtyEvent) -> bool {
            if let PtyEvent::Output(bytes) = event {
                self.0.lock().extend_from_slice(&bytes);
            }
            true
        }
    }

    // The one that would catch a wrapping that only looks right: a real shell,
    // a real PTY, and a command that has to reach it as an argument.
    #[test]
    fn the_wrapped_command_actually_runs_in_the_pty() {
        let (shell_id, name, expected) = if cfg!(windows) {
            ("cmd", "ver", "Windows")
        } else {
            ("bash", "pwd", "/")
        };
        let Some(shell) = crate::shell::available_shells_blocking()
            .into_iter()
            .find(|s| s.id == shell_id)
        else {
            return;
        };
        if crate::shell::wrap_argv(&shell.cmd, &shell.args, false, name, &[]).is_none() {
            return;
        }

        let m = PtyManager::new();
        // Force the wrap: the point under test is the shell path, not the
        // decision that leads to it (covered above).
        m.shell_names
            .lock()
            .insert(shell_id.into(), Arc::new(ShellProbe { names: HashSet::from([name.to_string()]), ..Default::default() }));

        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink: Arc<dyn EventSink> = Arc::new(Collector(seen.clone()));
        let mut args = spec(name, Some(shell_id));
        args.cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let id = m.spawn(sink, args).expect("wrapped spawn");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut got = String::new();
        let mut answered = false;
        while std::time::Instant::now() < deadline {
            got = String::from_utf8_lossy(&seen.lock()).into_owned();
            if got.contains(expected) {
                break;
            }
            // ConPTY opens by asking the terminal where the cursor is and will
            // not go on until something answers. xterm.js answers on its own;
            // in here we are the terminal.
            if !answered && got.contains("\u{1b}[6n") {
                answered = true;
                let _ = m.write(&id, b"\x1b[1;1R");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = m.kill(&id, false);
        assert!(
            got.contains(expected),
            "wrapped `{name}` produced no {expected:?}; got: {got:?}"
        );
    }

    // The frontend hands this object straight to invoke()/the socket, so the
    // field names here are a contract with `PtySpawnArgs` in backend/types.ts.
    #[test]
    fn the_spawn_payload_the_frontend_sends_round_trips() {
        let json = r#"{
            "cwd": "D:/p", "cmd": "cc", "args": ["--resume"],
            "cols": 80, "rows": 24,
            "wrap": { "shellId": "pwsh", "noProfile": false }
        }"#;
        let spec: PtySpawnArgs = serde_json::from_str(json).expect("payload shape");
        let wrap = spec.wrap.expect("wrap survived");
        assert_eq!(wrap.shell_id, "pwsh");
        assert!(!wrap.no_profile);

        // And a payload from a client that predates the field still spawns.
        let older = r#"{"cwd":"D:/p","cmd":"cc","args":[],"cols":80,"rows":24}"#;
        let spec: PtySpawnArgs = serde_json::from_str(older).expect("older payload");
        assert!(spec.wrap.is_none());
    }

    #[test]
    fn probe_output_splits_into_names_and_profile_additions() {
        let text = format!(
            "cc\nccGPT\n\n{}\nRALPH_OPENCODE_BINARY=C:\\npm\\opencode.cmd\nTERM=dumb\nPATH=x\nbroken\n=novalue\n",
            crate::shell::PROBE_SEPARATOR
        );
        let probe = parse_probe_output(&text, |k| k == "TERM" || k == "PATH");
        assert_eq!(probe.names.len(), 2);
        assert!(probe.names.contains("cc"));
        // What the profile adds and the app is missing, and nothing else: the
        // variables the process already has keep the value it already has.
        assert_eq!(probe.env.len(), 1);
        assert_eq!(
            probe.env.get("RALPH_OPENCODE_BINARY").map(String::as_str),
            Some("C:\\npm\\opencode.cmd")
        );
        assert!(!probe.env.contains_key("TERM"));
    }

    #[test]
    fn a_probe_that_printed_no_separator_is_still_read_as_names() {
        let probe = parse_probe_output("cc\nccGPT\n", |_| false);
        assert_eq!(probe.names.len(), 2);
        assert!(probe.env.is_empty());
    }

    #[test]
    fn probing_a_real_shell_finds_names_the_path_does_not_have() {
        let Some(shell) = a_shell() else { return };
        let Some(probe) = probe_shell_names(&shell) else {
            return;
        };
        assert!(!probe.names.is_empty(), "a shell with no functions or aliases");
        assert!(
            probe.names.iter().any(|n| which::which(n).is_err()),
            "every name the shell reported is also a binary, so the probe is not \
             telling us anything the PATH could not"
        );
        // The env half never carries anything this process already has: those
        // would be stale copies rather than additions.
        assert!(
            probe.env.keys().all(|k| std::env::var_os(k).is_none()),
            "the probe kept a variable this process already defines"
        );
    }
}
