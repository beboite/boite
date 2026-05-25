use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use uuid::Uuid;
use vte::{Params, Parser, Perform};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    #[serde(rename_all = "camelCase")]
    Output { data: Vec<u8> },
    #[serde(rename_all = "camelCase")]
    Title { value: String },
    #[serde(rename_all = "camelCase")]
    Exit { code: Option<i32> },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnArgs {
    pub thread_id: String,
    pub cwd: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub env: Option<HashMap<String, String>>,
}

const SCROLLBACK_CAPACITY: usize = 512 * 1024;

struct RingBuffer {
    buf: Vec<u8>,
    capacity: usize,
}

impl RingBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            buf: Vec::with_capacity(capacity.min(64 * 1024)),
            capacity,
        }
    }

    fn push(&mut self, data: &[u8]) {
        if data.len() >= self.capacity {
            self.buf.clear();
            self.buf
                .extend_from_slice(&data[data.len() - self.capacity..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.buf.extend_from_slice(data);
    }

    fn snapshot(&self) -> Vec<u8> {
        self.buf.clone()
    }
}

struct PtyHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    pid: Option<u32>,
    scrollback: Arc<Mutex<RingBuffer>>,
    scrollback_path: Option<PathBuf>,
}

#[derive(Clone, Default)]
pub struct PtyManager {
    inner: Arc<Mutex<HashMap<String, PtyHandle>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(
        &self,
        channel: Channel<PtyEvent>,
        spec: PtySpawnArgs,
        scrollback_path: Option<PathBuf>,
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

        let resolved_cmd = which::which(&spec.cmd)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| spec.cmd.clone());
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

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone_reader failed: {e}"))?;

        let master_arc: Arc<Mutex<Box<dyn MasterPty + Send>>> =
            Arc::new(Mutex::new(pair.master));
        let writer_arc: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(writer));
        let killer_arc: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>> =
            Arc::new(Mutex::new(killer));
        let pid = child.process_id();
        let scrollback = Arc::new(Mutex::new(RingBuffer::new(SCROLLBACK_CAPACITY)));

        let handle = PtyHandle {
            master: master_arc,
            writer: writer_arc,
            killer: killer_arc,
            pid,
            scrollback: scrollback.clone(),
            scrollback_path: scrollback_path.clone(),
        };

        self.inner.lock().insert(id.clone(), handle);

        // Reader loop: forward bytes + parse OSC titles. Owns the child, calls wait() at EOF.
        let inner_clone = self.inner.clone();
        let id_clone = id.clone();
        let channel_clone = channel.clone();
        let scrollback_for_loop = scrollback.clone();
        std::thread::spawn(move || {
            read_loop(reader, channel_clone.clone(), scrollback_for_loop);
            let exit_code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
            let final_bytes = scrollback.lock().snapshot();
            if let Some(path) = scrollback_path.as_ref() {
                if !final_bytes.is_empty() {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(path, &final_bytes);
                }
            }
            inner_clone.lock().remove(&id_clone);
            let _ = channel_clone.send(PtyEvent::Exit {
                code: Some(exit_code),
            });
        });

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let writer = {
            let map = self.inner.lock();
            let handle = map.get(id).ok_or_else(|| "pty not found".to_string())?;
            handle.writer.clone()
        };
        let mut writer = writer.lock();
        writer
            .write_all(data)
            .map_err(|e| format!("write failed: {e}"))?;
        writer.flush().map_err(|e| format!("flush failed: {e}"))?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let master = {
            let map = self.inner.lock();
            let handle = map.get(id).ok_or_else(|| "pty not found".to_string())?;
            handle.master.clone()
        };
        let guard = master.lock();
        guard
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))?;
        Ok(())
    }

    pub fn snapshot_scrollback(&self, id: &str) -> Option<Vec<u8>> {
        let scrollback = {
            let map = self.inner.lock();
            map.get(id).map(|h| h.scrollback.clone())?
        };
        let bytes = scrollback.lock().snapshot();
        Some(bytes)
    }

    pub fn flush_scrollback_to_disk(&self, id: &str) {
        let (scrollback, path) = {
            let map = self.inner.lock();
            match map.get(id) {
                Some(h) => (h.scrollback.clone(), h.scrollback_path.clone()),
                None => return,
            }
        };
        let Some(path) = path else { return };
        let bytes = scrollback.lock().snapshot();
        if bytes.is_empty() {
            return;
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, bytes);
    }

    pub fn kill(&self, id: &str, wait: bool) -> Result<(), String> {
        self.flush_scrollback_to_disk(id);
        let (killer, pid) = {
            let map = self.inner.lock();
            match map.get(id) {
                Some(handle) => (handle.killer.clone(), handle.pid),
                None => return Ok(()),
            }
        };
        #[cfg(target_os = "windows")]
        {
            if let Some(pid) = pid {
                force_kill_process_tree(pid);
            }
            let _ = killer.lock().kill();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = pid;
            killer
                .lock()
                .kill()
                .map_err(|e| format!("kill failed: {e}"))?;
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
        Ok(())
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

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    channel: Channel<PtyEvent>,
    scrollback: Arc<Mutex<RingBuffer>>,
) {
    let mut parser = Parser::new();
    let mut osc = OscPerform {
        channel: channel.clone(),
    };
    let mut buf = [0u8; 65536];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                scrollback.lock().push(&buf[..n]);
                let chunk = buf[..n].to_vec();
                if let Err(err) = channel.send(PtyEvent::Output { data: chunk }) {
                    eprintln!("[boite/pty] output channel closed: {err}");
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
    channel: Channel<PtyEvent>,
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
        let _ = self.channel.send(PtyEvent::Title {
            value: title.to_string(),
        });
    }

    fn print(&mut self, _: char) {}
    fn execute(&mut self, _: u8) {}
    fn hook(&mut self, _: &Params, _: &[u8], _: bool, _: char) {}
    fn put(&mut self, _: u8) {}
    fn unhook(&mut self) {}
    fn csi_dispatch(&mut self, _: &Params, _: &[u8], _: bool, _: char) {}
    fn esc_dispatch(&mut self, _: &[u8], _: bool, _: u8) {}
}
