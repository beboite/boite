use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::Sender;

use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vte::{Params, Parser, Perform};

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
    writer_tx: Sender<Vec<u8>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
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
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
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

        let resolved_cmd = self.resolve_cmd(&spec.cmd);
        let mut command = CommandBuilder::new(&resolved_cmd);
        command.cwd(&spec.cwd);
        for arg in &spec.args {
            command.arg(arg);
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

        let (writer_tx, writer_rx) = std::sync::mpsc::channel::<Vec<u8>>();
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
        tx.send(data.to_vec())
            .map_err(|_| "pty writer closed".to_string())
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
            let (killer, master) = {
                let map = self.inner.lock();
                match map.get(id) {
                    Some(handle) => (handle.killer.clone(), handle.master.clone()),
                    None => return Ok(()),
                }
            };
            killer
                .lock()
                .kill()
                .map_err(|e| format!("kill failed: {e}"))?;
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
