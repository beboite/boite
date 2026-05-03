use std::collections::HashMap;
use std::io::{Read, Write};
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
pub struct PtySpawnArgs {
    pub cwd: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub env: Option<HashMap<String, String>>,
}

struct PtyHandle {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

#[derive(Default)]
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

        let handle = PtyHandle {
            master: master_arc,
            writer: writer_arc,
            killer: killer_arc,
        };

        self.inner.lock().insert(id.clone(), handle);

        // Reader loop: forward bytes + parse OSC titles. Owns the child, calls wait() at EOF.
        let inner_clone = self.inner.clone();
        let id_clone = id.clone();
        let channel_clone = channel.clone();
        std::thread::spawn(move || {
            read_loop(reader, channel_clone.clone());
            let exit_code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            };
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

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let killer = {
            let map = self.inner.lock();
            let handle = map.get(id).ok_or_else(|| "pty not found".to_string())?;
            handle.killer.clone()
        };
        killer
            .lock()
            .kill()
            .map_err(|e| format!("kill failed: {e}"))?;
        // Don't remove the handle here — the reader thread cleans up after wait() returns.
        Ok(())
    }
}

fn read_loop(mut reader: Box<dyn Read + Send>, channel: Channel<PtyEvent>) {
    let mut parser = Parser::new();
    let mut osc = OscPerform {
        channel: channel.clone(),
    };
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
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
