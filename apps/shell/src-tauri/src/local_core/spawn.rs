//! Starting a core process: its command line, its Job Object when the shell
//! owns it, and what it prints on the way up.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::locate::{configure_core_resources, CoreCommand};
use super::{Launch, POLL_INTERVAL};
use crate::platform::{self, job, job::CoreJob};

/// The line the core prints on stdout once its RPC server accepts connections.
const READY_LINE: &str = "boite-core ready";

/// What a core this shell started said on its way up, kept to explain an
/// early exit or a start that never answered.
pub(super) enum Output {
    /// The last lines of stdout and stderr, for a core the shell owns.
    Ring(Arc<Mutex<VecDeque<String>>>),
    /// A resident core writes to `core-output.log`: what it wrote since `from`.
    Log { path: PathBuf, from: u64 },
}

/// How many lines of the core's output an error quotes.
const TAIL_LINES: usize = 20;

impl Output {
    fn tail(&self) -> Vec<String> {
        match self {
            Output::Ring(lines) => lines.lock().map(|lines| lines.iter().cloned().collect()).unwrap_or_default(),
            Output::Log { path, from } => {
                use std::io::{Seek, SeekFrom};
                let mut text = Vec::new();
                if let Ok(mut file) = std::fs::File::open(path) {
                    // The tail only: a log that grew by megabytes still costs one small read.
                    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
                    let start = (*from).max(length.saturating_sub(64 * 1024));
                    if file.seek(SeekFrom::Start(start)).is_ok() {
                        let _ = file.read_to_end(&mut text);
                    }
                }
                let text = String::from_utf8_lossy(&text);
                let lines: Vec<String> = text.lines().filter(|line| !line.trim().is_empty()).map(str::to_string).collect();
                lines[lines.len().saturating_sub(TAIL_LINES)..].to_vec()
            }
        }
    }

    /// `: <what it printed>` for an error message, or a note that it printed nothing.
    pub(super) fn quoted(&self) -> String {
        let lines = self.tail();
        if lines.is_empty() {
            return match self {
                Output::Ring(_) => "; it printed nothing".to_string(),
                Output::Log { path, .. } => format!("; it wrote nothing to {}", path.display()),
            };
        }
        format!(":\n{}", lines.join("\n"))
    }
}

fn remember(lines: &Mutex<VecDeque<String>>, line: &str) {
    if let Ok(mut lines) = lines.lock() {
        if lines.len() == TAIL_LINES {
            lines.pop_front();
        }
        lines.push_back(line.to_string());
    }
}

/// A core this shell started.
pub(super) struct Spawned {
    pub(super) child: Child,
    /// Set once the core printed `READY_LINE` (owned cores only: a resident
    /// core's stdout goes to its log file).
    pub(super) ready: Arc<AtomicBool>,
    pub(super) output: Output,
    readers: Vec<std::thread::JoinHandle<()>>,
}

impl Spawned {
    /// Lets the pipe readers take what the core wrote before it exited, for a
    /// moment at most: a process the core started can hold the pipe open.
    pub(super) fn settle(&self) {
        let deadline = Instant::now() + Duration::from_millis(300);
        while self.readers.iter().any(|reader| !reader.is_finished()) && Instant::now() < deadline {
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

pub(super) fn spawn_core(launch: &Launch) -> Result<(Spawned, Option<CoreJob>), String> {
    let CoreCommand { program, args, working_directory } = launch.command.clone()?;
    let job = if launch.resident { None } else { Some(job::create_core_job()?) };

    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = if launch.resident {
        // No pipe belongs to the shell after it exits. Broken stdout must not kill the host.
        std::fs::create_dir_all(&launch.directory).map_err(|e| format!("{} could not be created: {e}", launch.directory.display()))?;
        let path = launch.directory.join("core-output.log");
        // An append handle on Windows lacks FILE_WRITE_DATA, so it cannot truncate: a separate write handle does.
        if std::fs::metadata(&path).map(|m| m.len() > 8 * 1024 * 1024).unwrap_or(false) {
            std::fs::OpenOptions::new().write(true).truncate(true).open(&path).map_err(|e| format!("core-output.log could not be truncated: {e}"))?;
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("core-output.log could not be opened: {e}"))?;
        let from = file.metadata().map(|m| m.len()).unwrap_or(0);
        command.stdout(Stdio::from(file.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(file));
        #[cfg(unix)]
        { use std::os::unix::process::CommandExt; command.process_group(0); }
        Output::Log { path, from }
    } else {
        Output::Ring(Arc::new(Mutex::new(VecDeque::with_capacity(TAIL_LINES))))
    };
    if let Some(directory) = working_directory {
        command.current_dir(directory);
    }
    if let Some(resources) = &launch.resources { configure_core_resources(&mut command, resources); }
    platform::prepare_command(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("the core could not be started with `{program}`: {error}"))?;

    if let Some(ref owned) = job {
        if let Err(error) = job::assign(owned, &child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("the core could not be put in this shell's job object: {error}"));
        }
    }

    let ready = Arc::new(AtomicBool::new(false));
    let ring = match &output {
        Output::Ring(lines) => Some(lines.clone()),
        Output::Log { .. } => None,
    };
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let flag = ready.clone();
        let ring = ring.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if line.contains(READY_LINE) {
                    flag.store(true, Ordering::Release);
                }
                if let Some(ring) = &ring { remember(ring, &line); }
                eprintln!("[core] {line}");
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if let Some(ring) = &ring { remember(ring, &line); }
                eprintln!("[core] {line}");
            }
        }));
    }

    Ok((Spawned { child, ready, output, readers }, job))
}
