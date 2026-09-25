//! The resolution against a stand-in core: adopt, replace, restart, hold.

use super::*;
use super::health::read_core_file;
use super::locate::core_args;
use std::path::Path;
use std::process::{Child, Command, Stdio};

/// A stand-in core. `serve` writes `core.json` into its `--data-dir`,
/// answers `/health` with its version and pid and stops on an authorised
/// `POST /shutdown`; `fail` exits at once with a reason on stderr, as the
/// real core does on a held lock; `hang` never answers.
const FAKE_CORE: &str = r#"
const [version, mode] = process.argv.slice(2);
const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
if (mode === 'fail') {
  console.error(`error: another core is already running on ${dir} (pid 1)`);
  process.exit(3);
}
if (mode === 'serve') {
  const token = 'test-token';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, version, pid: process.pid });
    if (url.pathname === '/shutdown' && request.method === 'POST' && request.headers.get('authorization') === `Bearer ${token}`) {
      setTimeout(() => process.exit(0), 20);
      return Response.json({ ok: true }, { status: 202 });
    }
    return new Response('no', { status: 404 });
  } });
  await Bun.write(`${dir}/core.json`, JSON.stringify({ port: server.port, host: '127.0.0.1', token, pid: process.pid, version }));
  console.log('boite-core ready');
}
setInterval(() => {}, 1000);
"#;

fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("boite-core-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("fake-core.ts"), FAKE_CORE).unwrap();
    directory
}

fn fake_command(directory: &Path, version: &str, mode: &str) -> CoreCommand {
    let mut args = vec![directory.join("fake-core.ts").display().to_string(), version.to_string(), mode.to_string()];
    args.extend(core_args(Channel::Stable, directory));
    CoreCommand { program: "bun".to_string(), args, working_directory: None }
}

fn state(directory: &Path, shell_version: &str, core: CoreCommand, resident: bool, timeout: Duration) -> CoreState {
    CoreState::new(Launch {
        directory: directory.to_path_buf(),
        command: Ok(core),
        resources: None,
        resident,
        version: shell_version.to_string(),
        timeout,
    })
}

/// Starts a core outside any shell, as an earlier install left it running.
fn running_core(directory: &Path, version: &str) -> (Child, u32) {
    let core = fake_command(directory, version, "serve");
    let mut command = Command::new(&core.program);
    command.args(&core.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    platform::prepare_command(&mut command);
    let child = command.spawn().expect("bun runs the fake core");
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !matches!(read_core_file(&directory.join("core.json")), Ok(Some(ref file)) if file.pid == Some(pid)) {
        assert!(Instant::now() < deadline, "the fake core never wrote core.json");
        std::thread::sleep(Duration::from_millis(20));
    }
    (child, pid)
}

fn spawned_pid(state: &CoreState) -> Option<u32> {
    state.child.lock().unwrap().as_ref().map(|spawned| spawned.child.id())
}

#[test]
fn a_core_that_exits_at_start_is_reported_at_once_with_what_it_said() {
    let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
    for resident in [false, true] {
        let directory = scratch(if resident { "early-resident" } else { "early-owned" });
        let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "fail"), resident, Duration::from_secs(30));
        let started = Instant::now();
        let error = resolve_core(&state).err().expect("a core that exits cannot be adopted");
        assert!(started.elapsed() < Duration::from_secs(10), "resident {resident}: noticed after {:?}", started.elapsed());
        assert!(error.contains("exited"), "resident {resident}: {error}");
        assert!(error.contains("another core is already running"), "resident {resident}: the core's reason is missing: {error}");
        assert!(spawned_pid(&state).is_none());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn a_running_core_of_another_version_is_stopped_and_replaced() {
    let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
    let directory = scratch("stale");
    let (mut old, old_pid) = running_core(&directory, "1.0.0");
    let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
    let outcome = resolve_core(&state);
    let old_status = old.wait().unwrap();
    state.kill_child();
    let (endpoint, pid) = outcome.expect("the shell starts its own core once the old one stopped");
    assert_ne!(pid, Some(old_pid));
    assert!(endpoint.url.starts_with("http://127.0.0.1:"));
    // The old core left on its own, through /shutdown, not by a kill.
    assert_eq!(old_status.code(), Some(0));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_running_core_of_this_version_is_adopted_and_nothing_is_started() {
    let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
    let directory = scratch("current");
    let (mut core, pid) = running_core(&directory, "2.0.0");
    // A start would fail: adopting is the only way this resolves.
    let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "fail"), false, Duration::from_secs(30));
    let outcome = resolve_core(&state);
    let _ = core.kill();
    let _ = core.wait();
    assert_eq!(outcome.expect("the running core is adopted").1, Some(pid));
    assert!(spawned_pid(&state).is_none());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_core_that_died_is_replaced_by_the_next_caller() {
    let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
    let directory = scratch("restart");
    let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
    publish(&state.slot, resolve_core(&state));
    let first = current_endpoint(&state).expect("the first core answers");
    let first_pid = spawned_pid(&state).unwrap();
    assert_eq!(current_endpoint(&state).unwrap().url, first.url, "a live core is kept");
    {
        let mut guard = state.child.lock().unwrap();
        let spawned = guard.as_mut().unwrap();
        spawned.child.kill().unwrap();
        // A crash, as the shell meets it: nobody has waited on the core.
        // On POSIX it is now a zombie, which is waited for here without
        // reaping it (`WNOWAIT`), so the reaping stays the shell's job.
        #[cfg(unix)]
        {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let options = libc::WEXITED | libc::WNOWAIT;
            assert_eq!(unsafe { libc::waitid(libc::P_PID, first_pid as libc::id_t, &mut info, options) }, 0);
            assert!(platform::process::alive(first_pid), "the zombie this test reproduces was reaped already");
        }
        // Windows has no zombie: the process handle the `Child` holds
        // stays signalled once it exits, and waiting on it reaps nothing.
        #[cfg(windows)]
        spawned.child.wait().unwrap();
    }
    let second = current_endpoint(&state);
    let second_pid = spawned_pid(&state);
    state.kill_child();
    let second = second.expect("a new core is started for the next caller");
    assert_ne!(second_pid, Some(first_pid));
    assert_ne!(second.url, first.url);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_core_stopped_for_an_install_stays_stopped_until_the_hold_is_released() {
    let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
    let directory = scratch("hold");
    let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
    publish(&state.slot, resolve_core(&state));
    let first = current_endpoint(&state).expect("the first core answers");
    let first_pid = spawned_pid(&state).unwrap();
    state.stop_for_install().expect("the core stops on request");
    assert!(!platform::process::alive(first_pid), "the core outlived the stop");
    // The window asks again once it lost the core: nothing may start.
    assert_eq!(current_endpoint(&state).err().as_deref(), Some(HELD));
    assert!(spawned_pid(&state).is_none_or(|pid| pid == first_pid), "a core was started during the install");
    // The installer never ran: the next ask brings the engine back.
    state.release_hold();
    let second = current_endpoint(&state);
    state.kill_child();
    assert_ne!(second.expect("a new core after the hold").url, first.url);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_slow_resident_core_is_left_running_and_a_slow_owned_one_is_stopped() {
    let _process_guard = crate::PROCESS_TEST_LOCK.lock().unwrap();
    let directory = scratch("slow");
    let resident = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "hang"), true, Duration::from_secs(1));
    let error = resolve_core(&resident).err().expect("a core that never answers is not adopted");
    assert!(error.contains("still starting"), "{error}");
    let pid = spawned_pid(&resident).expect("the resident core is kept");
    // The next try waits on that same process rather than starting another.
    let _ = resolve_core(&resident);
    assert_eq!(spawned_pid(&resident), Some(pid));
    if let Some(mut spawned) = resident.child.lock().unwrap().take() {
        let _ = spawned.child.kill();
        let _ = spawned.child.wait();
    }

    let owned = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "hang"), false, Duration::from_secs(1));
    let error = resolve_core(&owned).err().expect("a core that never answers is not adopted");
    assert!(error.contains("did not write"), "{error}");
    assert!(spawned_pid(&owned).is_none(), "an owned core that never answered is stopped");
    std::fs::remove_dir_all(directory).unwrap();
}
