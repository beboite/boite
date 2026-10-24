//! The resolution against a stand-in core: adopt, replace, restart, hold.

use super::*;
use super::health::read_core_file;
use super::locate::core_args;
use std::path::Path;
use std::process::{Child, Command, Stdio};

/// A stand-in core. `serve` writes `core.json` into its `--data-dir`,
/// answers `/health` with its version and pid and stops on an authorised
/// `POST /shutdown`; `fail` exits at once with a reason on stderr, as the
/// real core does on a held lock; `hang` never answers; `compact` announces
/// its work in `core.starting.json` until the time its test wrote in
/// `compact-until`, however long Bun took to start, then serves 300 ms later.
const FAKE_CORE: &str = r#"
const [version, mode] = process.argv.slice(2);
const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
if (mode === 'fail') {
  console.error(`error: another core is already running on ${dir} (pid 1)`);
  process.exit(3);
}
if (mode === 'compact') {
  const status = `${dir}/core.starting.json`;
  await Bun.write(status, JSON.stringify({ pid: process.pid, phase: 'compacting', startedAt: Date.now(), bytes: 1 }));
  await Bun.sleep(Math.max(0, Number(await Bun.file(`${dir}/compact-until`).text()) - Date.now()));
  (await import('node:fs')).rmSync(status);
  // The real core opens its journal between the end of that work and `core.json`.
  await Bun.sleep(300);
}
if (mode === 'serve' || mode === 'compact') {
  const token = 'test-token';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, version, pid: process.pid });
    if ((url.pathname === '/shutdown' || url.pathname === '/shutdown-if-idle' && url.searchParams.get('pid') === String(process.pid)) && request.method === 'POST' && request.headers.get('authorization') === `Bearer ${token}`) {
      setTimeout(() => process.exit(0), 20);
      return Response.json({ ok: true, pid: process.pid }, { status: 202 });
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
        bundle_hash: None,
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
    let _process_guard = crate::process_test_guard();
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
    let _process_guard = crate::process_test_guard();
    let directory = scratch("stale");
    let (mut old, old_pid) = running_core(&directory, "1.0.0");
    let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
    let outcome = resolve_core(&state);
    let old_status = old.wait().unwrap();
    state.kill_child();
    let (endpoint, pid, _) = outcome.expect("the shell starts its own core once the old one stopped");
    assert_ne!(pid, Some(old_pid));
    assert!(endpoint.url.starts_with("http://127.0.0.1:"));
    // The old core left on its own, through /shutdown, not by a kill.
    assert_eq!(old_status.code(), Some(0));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_running_core_of_this_version_is_adopted_and_nothing_is_started() {
    let _process_guard = crate::process_test_guard();
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
fn a_same_version_core_without_the_installed_bundle_is_replaced() {
    let _process_guard = crate::process_test_guard();
    let directory = scratch("stale-bundle");
    let (mut old, old_pid) = running_core(&directory, "2.0.0");
    let mut state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
    state.launch.bundle_hash = Some("installed".to_string());
    let outcome = resolve_core(&state);
    let deadline = Instant::now() + Duration::from_secs(5);
    let old_status = loop {
        match old.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_INTERVAL),
            Ok(None) => break Err("the previous core did not exit within five seconds".to_string()),
            Err(error) => break Err(format!("waiting for the previous core failed: {error}")),
        }
    };
    if old_status.is_err() {
        let _ = old.kill();
        let _ = old.try_wait();
    }
    state.kill_child();
    std::fs::remove_dir_all(directory).unwrap();
    let old_status = old_status.expect("the previous core exits after replacement");
    assert_ne!(outcome.expect("a same-version reinstall replaces the previous core").1, Some(old_pid));
    assert_eq!(old_status.code(), Some(0));
}

#[test]
fn a_core_that_died_is_replaced_by_the_next_caller() {
    let _process_guard = crate::process_test_guard();
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
    let _process_guard = crate::process_test_guard();
    let directory = scratch("hold");
    let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, Duration::from_secs(30));
    publish(&state.slot, resolve_core(&state));
    let first = current_endpoint(&state).expect("the first core answers");
    let first_pid = spawned_pid(&state).unwrap();
    let control = Mutex::new(crate::update_stop::InstallState::Waiting);
    assert!(state.wait_for_install(&control, false, || true, || {}).expect("the idle core stops on request"));
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
    let _process_guard = crate::process_test_guard();
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

#[test]
fn a_core_compacting_its_journal_is_waited_on_past_the_timeout_and_says_so() {
    let _process_guard = crate::process_test_guard();
    let directory = scratch("compact");
    // The timeout leaves Bun's cold start on a CI runner room to write the
    // marker; the core serves only once that timeout has passed.
    let timeout = Duration::from_secs(4);
    let until = std::time::SystemTime::now() + timeout + Duration::from_millis(500);
    std::fs::write(directory.join("compact-until"), until.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string()).unwrap();
    let state = state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "compact"), false, timeout);
    let watcher = {
        let directory = directory.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(starting) = starting::read_starting(&directory) { return Some(starting); }
                if Instant::now() > deadline { return None; }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
    };
    let started = Instant::now();
    let outcome = resolve_core(&state);
    let waited = started.elapsed();
    state.kill_child();
    let seen = watcher.join().unwrap().expect("the core announced its work");
    assert_eq!(seen.phase, "compacting");
    assert!(outcome.is_ok(), "{:?}", outcome.err());
    assert!(waited >= timeout, "the core served after {waited:?}, inside the {timeout:?} timeout: nothing was waited on past it");
    // Gone once the core serves, and a file a dead core left counts for nothing.
    assert!(starting::read_starting(&directory).is_none());
    std::fs::write(directory.join("core.starting.json"), r#"{"pid":4294967294,"phase":"compacting","startedAt":1,"bytes":1}"#).unwrap();
    assert!(starting::read_starting(&directory).is_none());
    // A file left by a core that crashed, whose pid now names a later live
    // process (this test's own), counts for nothing either: the shell starts a core.
    let pid = std::process::id();
    let (own, earlier) = health::own_start_and_an_earlier_one();
    let marker = |start: &health::CoreStart| {
        let mut file = serde_json::json!({ "pid": pid, "phase": "compacting", "startedAt": start.at.unwrap_or(u64::MAX / 2), "bytes": 1 });
        if let Some(key) = &start.key { file["startKey"] = serde_json::json!(key); }
        std::fs::write(directory.join("core.starting.json"), file.to_string()).unwrap();
    };
    marker(&earlier);
    assert!(starting::read_starting(&directory).is_none(), "a marker older than the process holding its pid is stale");
    marker(&own);
    assert!(starting::read_starting(&directory).is_some(), "the process that wrote the marker is that core");
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_core_another_shell_started_that_dies_while_compacting_is_replaced_at_once() {
    let _process_guard = crate::process_test_guard();
    let directory = scratch("compact-dies");
    // That core never gets to serve: it is killed while compacting, and its marker stays.
    let until = std::time::SystemTime::now() + Duration::from_secs(120);
    std::fs::write(directory.join("compact-until"), until.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string()).unwrap();
    let core = fake_command(&directory, "2.0.0", "compact");
    let mut command = Command::new(&core.program);
    command.args(&core.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    platform::prepare_command(&mut command);
    let mut earlier = command.spawn().expect("bun runs the fake core");
    let deadline = Instant::now() + Duration::from_secs(20);
    while starting::read_starting(&directory).is_none() {
        assert!(Instant::now() < deadline, "the fake core never announced its work");
        std::thread::sleep(Duration::from_millis(20));
    }
    let timeout = Duration::from_secs(30);
    let state = std::sync::Arc::new(state(&directory, "2.0.0", fake_command(&directory, "2.0.0", "serve"), false, timeout));
    let resolution = { let state = state.clone(); std::thread::spawn(move || resolve_core(&state)) };
    // The resolution dates its sighting once it chose to wait on that core.
    let deadline = Instant::now() + Duration::from_secs(20);
    while state.slot.0.lock().unwrap().announced.is_none() {
        assert!(Instant::now() < deadline, "the resolution never waited on the compacting core");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(spawned_pid(&state).is_none(), "a core was started beside the compacting one");
    let started = Instant::now();
    let _ = earlier.kill();
    let _ = earlier.wait();
    let outcome = resolution.join().unwrap();
    let waited = started.elapsed();
    let pid = spawned_pid(&state);
    state.kill_child();
    std::fs::remove_dir_all(directory).unwrap();
    let (_, served, _) = outcome.expect("a core of its own once the one it waited on is gone");
    assert_eq!(served, pid);
    assert_ne!(served, Some(earlier.id()));
    assert!(waited < timeout, "replaced after {waited:?}, the whole {timeout:?} timeout");
}

#[test]
fn a_caller_waits_a_whole_patience_past_the_last_time_the_resolution_saw_the_core_at_work() {
    // Patience from the later of the caller's start and the last sighting.
    let begun = Instant::now();
    let (patience, later) = (Duration::from_secs(5), Duration::from_secs(3));
    assert_eq!(endpoint_deadline(begun, None, patience), begun + patience);
    assert_eq!(endpoint_deadline(begun + later, Some(begun), patience), begun + later + patience);
    assert_eq!(endpoint_deadline(begun, Some(begun + later), patience), begun + later + patience);

    // A sighting moved while the caller sleeps wakes nobody: the caller reads
    // it when it wakes, at its own deadline 2 s in at the latest, and sleeps
    // on to the later one. The core serves only once the caller did, so a
    // caller that read the sighting once gives up first. A runner too loaded
    // to move the sighting before that deadline gets another try, and none
    // in three fails.
    let mut exercised = false;
    for _ in 0..3 {
        let slot = std::sync::Arc::new((Mutex::new(Slot::default()), Condvar::new()));
        let (began, waiting) = std::sync::mpsc::channel();
        let caller = {
            let slot = slot.clone();
            std::thread::spawn(move || {
                began.send(Instant::now()).unwrap();
                wait_for_endpoint(&slot, Duration::from_secs(2)).map(|settled| settled.outcome)
            })
        };
        let entered = waiting.recv().unwrap();
        let until = |deadline: Instant, what: &str, done: &dyn Fn(&Slot) -> bool| loop {
            if done(&slot.0.lock().unwrap()) || caller.is_finished() { return; }
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(5));
        };
        until(Instant::now() + Duration::from_secs(10), "the caller never went to sleep", &|slot| slot.sleeps > 0);
        let moved = {
            let mut guard = slot.0.lock().unwrap();
            guard.announced = Some(Instant::now() + Duration::from_secs(10));
            Instant::now()
        };
        if moved < entered + Duration::from_secs(2) {
            until(Instant::now() + Duration::from_secs(10), "the caller never woke to its first deadline", &|slot| slot.extended > 0);
        }
        let read_the_move = slot.0.lock().unwrap().extended > 0;
        let endpoint = CoreEndpoint { url: "http://127.0.0.1:1".to_string(), token: "t".to_string() };
        publish(&slot, Ok((endpoint, None, health::CoreStart::default())));
        let outcome = caller.join().unwrap().and_then(|outcome| outcome);
        if moved < entered + Duration::from_secs(2) {
            assert!(read_the_move && outcome.is_ok(), "the caller gave up without reading the moved sighting: {:?}", outcome.err());
            exercised = true;
            break;
        }
        eprintln!("schedule missed: the sighting moved {:?} after the caller began", moved - entered);
    }
    assert!(exercised, "three runs missed the schedule");
    // Nothing seen: the caller gives up at its patience.
    let idle = (Mutex::new(Slot::default()), Condvar::new());
    let started = Instant::now();
    assert!(wait_for_endpoint(&idle, Duration::from_millis(200)).is_err());
    assert!(started.elapsed() >= Duration::from_millis(200));
}

#[test]
fn a_settled_core_whose_pid_now_names_a_later_process_is_stale() {
    // This test's own process stands for the one that got the dead core's number.
    let pid = std::process::id();
    let (own, earlier) = health::own_start_and_an_earlier_one();
    let endpoint = CoreEndpoint { url: "http://127.0.0.1:1".to_string(), token: "t".to_string() };
    let settled = |start| Settled { outcome: Ok(endpoint.clone()), pid: Some(pid), start, generation: 0 };
    assert!(settled(earlier).stale(), "a process that started after the core is not that core");
    assert!(!settled(own).stale());
    assert!(!settled(health::CoreStart::default()).stale(), "an unknown start time keeps the liveness answer");
}
