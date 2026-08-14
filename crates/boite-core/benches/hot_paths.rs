//! Numbers for the four claims that had none attached.
//!
//! Boite's rule for the whole repair is that an optimisation with no
//! measurement attached is removed. Four places in `boite-core` carry a comment
//! asserting a cost, and each of them is a decision somebody would otherwise
//! have to relitigate from intuition:
//!
//! - `session::agent_turns` runs on a one-second timer for every open agent
//!   thread, and its own doc calls it "the most expensive thing in the app" if
//!   done wrong. There is a `POLL_DEADLINE_MS` that abandons a slow read, and
//!   nothing said what the normal one costs.
//! - `transcript::plain` is why there is no buffer in front of the transcript
//!   file: the escapes are stripped on the way out instead of the way in.
//! - `search::transcripts` is scanned at query time rather than indexed, on the
//!   argument that "twenty live terminals is a couple of megabytes read once".
//! - `screen::Screen::trimmed` bounds what the window may push, and it runs on
//!   the receiving side of a heartbeat.
//!
//! Run: `cargo bench -p boite-core`. Not in CI, and that is deliberate — a
//! benchmark on a shared runner measures the runner. What CI does do is compile
//! this, so a bench cannot rot into something that no longer builds.
//!
//! # What they said the first time
//!
//! Written down because a number nobody recorded is a measurement that has to be
//! taken again before it can be argued with. Windows 11, a machine with real
//! claude, codex and opencode session stores on it, so these are what a working
//! install costs rather than a floor:
//!
//! ```text
//! transcript::plain      256 KB           477 µs     542 MiB/s
//! search::transcripts    20 files, hit    649 µs
//! search::transcripts    20 files, miss  17.9 ms     reads every file to the end
//! session::agent_turns   three agents    10.1 ms
//! session::agent_turns   claude only       95 µs
//! screen::trimmed        200 panes         23 µs
//! ```
//!
//! Three of those confirm what the comments claimed. The fourth is a finding:
//! **claude costs 95 µs and the other two cost the remaining 10 ms between
//! them**, a hundredfold difference for the same question. Claude answers from a
//! directory of small JSON files; codex opens `state_*.sqlite` and then reads a
//! rollout, opencode opens a database of its own. Whatever is done about that,
//! it is now a number rather than a suspicion, and `POLL_DEADLINE_MS` is
//! abandoning a read that normally lands in ten milliseconds rather than one
//! that normally lands in a hundred microseconds.

use std::hint::black_box;
use std::io::Write;

use criterion::{criterion_group, criterion_main, Criterion, Throughput};

/// A transcript that looks like one: a progress bar redrawing itself, colour,
/// cursor moves, and ordinary output in between.
fn terminal_output(lines: usize) -> Vec<u8> {
    let mut out = Vec::new();
    for i in 0..lines {
        // A spinner frame the way an agent actually prints one, over the top of
        // itself, which is what makes a transcript large without being long.
        let _ = write!(
            out,
            "\x1b[2K\r\x1b[36m✻\x1b[0m Crunched for {i}s \x1b[90m({i} tokens)\x1b[0m"
        );
        if i % 8 == 0 {
            let _ = writeln!(
                out,
                "\r\n\x1b[1msrc/lib/features/thread/statusEngine.ts\x1b[0m:{i}: something happened"
            );
        }
    }
    out
}

fn scratch(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("boite-bench-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Stripping escapes out of what a terminal printed.
///
/// Sized at 256 KiB because that is the window `search::transcripts` reads and
/// the ceiling `agent_turns` puts on a rollout file, so it is the number both
/// of the other claims lean on.
fn transcript_plain(c: &mut Criterion) {
    let bytes = terminal_output(4_000);
    let mut group = c.benchmark_group("transcript::plain");
    group.throughput(Throughput::Bytes(bytes.len() as u64));
    group.bench_function("mixed escapes", |b| {
        b.iter(|| boite_core::transcript::plain(black_box(&bytes)))
    });
    group.finish();
}

/// Scanning transcripts for a substring, which is what `workspace_search` does
/// instead of indexing them.
///
/// Twenty terminals is the number the decision was argued on, so that is the
/// number this runs.
fn search_transcripts(c: &mut Criterion) {
    let dir = scratch("search");
    let bytes = terminal_output(4_000);
    for i in 0..20 {
        std::fs::write(dir.join(format!("thread-{i}.log")), &bytes).unwrap();
    }
    let total: u64 = (bytes.len() * 20) as u64;

    let mut group = c.benchmark_group("search::transcripts");
    group.throughput(Throughput::Bytes(total));
    // A needle that is there, and one that is not: a miss reads every file to
    // the end, so it is the honest worst case rather than the happy path.
    group.bench_function("20 terminals, hit", |b| {
        b.iter(|| boite_core::search::transcripts(black_box(&dir), "statusEngine", 50))
    });
    group.bench_function("20 terminals, miss", |b| {
        b.iter(|| boite_core::search::transcripts(black_box(&dir), "zzzznothing", 50))
    });
    group.finish();
    let _ = std::fs::remove_dir_all(&dir);
}

/// What every open agent thread costs, once a second.
///
/// Run against the real stores, because a fixture would measure the fixture:
/// the cost here is a directory walk plus two SQLite opens plus a file read, and
/// on a machine with no agent sessions this measures the walk finding nothing,
/// which is itself the floor worth knowing.
fn agent_turns(c: &mut Criterion) {
    use boite_core::session::TurnQuery;
    let queries: Vec<TurnQuery> = ["claude", "codex", "opencode"]
        .iter()
        .map(|kind| TurnQuery {
            kind: kind.to_string(),
            session_id: None,
            cwd: ".".to_string(),
        })
        .collect();

    let mut group = c.benchmark_group("session::agent_turns");
    // One pass per agent rather than per thread is the design; both are here so
    // the difference is a number instead of an assertion.
    group.bench_function("three agents", |b| {
        b.iter(|| boite_core::session::agent_turns(black_box(&queries)))
    });
    group.bench_function("claude only", |b| {
        b.iter(|| boite_core::session::agent_turns(black_box(&queries[..1])))
    });
    group.finish();
}

/// Bounding a screen description on the way in.
///
/// The window pushes this every five seconds, and it is the half that may be
/// misbehaving, so the receiver bounds it rather than trusting it.
fn screen_trimmed(c: &mut Criterion) {
    use boite_core::screen::{Pane, Rect, Screen, Window};
    let pane = |i: usize| Pane {
        id: format!("pane-{i}"),
        kind: "thread".into(),
        title: format!("Claude #{i}"),
        thread_id: Some(format!("thread-{i}")),
        rect: Rect { x: 0.0, y: 0.0, w: 640.0, h: 480.0 },
        focused: i == 0,
        url: None,
        page: None,
        driven_by: None,
    };
    // Deliberately over both caps, because trimming is what is being measured
    // and a screen already inside them does nothing.
    let screen = Screen {
        at: 0,
        project_id: "p".into(),
        window: Window { width: 1920.0, height: 1080.0, focused: true },
        panes: (0..200).map(pane).collect(),
        overlays: (0..80).map(|i| format!("overlay-{i}")).collect(),
    };

    c.bench_function("screen::trimmed", |b| {
        b.iter(|| black_box(screen.clone()).trimmed())
    });
}

criterion_group!(
    benches,
    transcript_plain,
    search_transcripts,
    agent_turns,
    screen_trimmed
);
criterion_main!(benches);
