//! What a terminal printed: the recent screen in memory, the whole run on disk.
//!
//! There were two rings before this, and they were not the same ring. The
//! desktop's was 256 KB, hardcoded, with no notion of how much had ever been
//! written; the server's was configurable and tracked an absolute offset so a
//! reattaching client could ask for the delta instead of the whole buffer. So a
//! reattach on a local workspace repainted the entire screen and a reattach on a
//! remote one did not, and neither behaviour was a decision.
//!
//! One [`Scrollback`] now, and it does the thing neither of them did: it writes
//! what it saw to a file. A PTY's output used to die with the process, which
//! meant that the one place an agent's actual work is visible was also the one
//! place nothing was ever written down. An agent asked what went wrong an hour
//! ago had nothing to read.
//!
//! **Bytes, not text.** What a terminal prints is a stream with escape
//! sequences in it, and a chunk boundary can fall in the middle of one, or in
//! the middle of a UTF-8 character. Decoding here would corrupt both. The file
//! holds exactly what the child wrote, and [`plain`] is what strips it when
//! somebody wants to read it.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// How much of a run is kept on disk, per thread, before it rolls over.
///
/// Two files of this, so a thread keeps between 8 and 16 MB of its own history.
/// A busy agent writes a megabyte an hour, so that is most of a working day,
/// and the alternative is a directory that grows until somebody notices.
pub const MAX_TRANSCRIPT_BYTES: u64 = 8 * 1024 * 1024;

// Written straight through, with no buffer in front of it.
//
// There was a `BufWriter` here with a size threshold, and then a deadline
// beside it, and both were wrong for the same reason: a terminal that prints
// once and goes quiet never reaches either, so the one thing anybody wants to
// read — what it said before it stopped — was the one thing still in memory.
// A deadline cannot fix that either, because nothing calls back when there is
// no next write.
//
// So the buffer is gone. A write to a local file is a memcpy into the page
// cache, the PTY reader already coalesces up to a read's worth of output, and
// the optimisation had no measurement attached to it in the first place.

/// The recent screen, plus wherever the rest of it is being written.
pub struct Scrollback {
    buf: VecDeque<u8>,
    cap: usize,
    /// Absolute count of bytes ever written. The oldest byte still in `buf`
    /// sits at `written - buf.len()`, and clients track this offset so a
    /// reattach can ask for the delta instead of the whole ring.
    written: u64,
    file: Option<Sink>,
}

struct Sink {
    path: PathBuf,
    out: File,
    /// Bytes in the current file, for the roll-over. Not the same as `written`:
    /// a reopened transcript starts counting from what was already there.
    size: u64,
}

impl Scrollback {
    pub fn new(cap: usize) -> Scrollback {
        Scrollback {
            buf: VecDeque::new(),
            cap,
            written: 0,
            file: None,
        }
    }

    /// Also writes everything to this file, appending to whatever is there.
    ///
    /// Appending rather than truncating: a thread whose PTY restarts is the
    /// same conversation, and starting the file again would lose exactly the
    /// part somebody is about to go looking for. A file that cannot be opened
    /// is not an error — the terminal still works, it just has no memory — so
    /// this answers `false` and the caller decides whether to say anything.
    pub fn to_file(&mut self, path: &Path) -> bool {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
            return false;
        };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        self.file = Some(Sink {
            path: path.to_path_buf(),
            out: file,
            size,
        });
        true
    }

    pub fn extend(&mut self, bytes: &[u8]) {
        self.written += bytes.len() as u64;
        if bytes.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&bytes[bytes.len() - self.cap..]);
        } else {
            self.buf.extend(bytes.iter().copied());
            while self.buf.len() > self.cap {
                self.buf.pop_front();
            }
        }
        if let Some(sink) = &mut self.file {
            sink.append(bytes);
        }
    }

    /// Asks the OS to write what it is holding. Kept for the end of a run.
    ///
    /// Nearly a no-op now that there is no buffer of our own, and worth keeping
    /// anyway: it is where a caller says "this run is over", and the day
    /// something is buffered again this is the line that already existed.
    pub fn flush(&mut self) {
        if let Some(sink) = &mut self.file {
            let _ = sink.out.flush();
        }
    }

    pub fn total(&self) -> u64 {
        self.written
    }

    pub fn start(&self) -> u64 {
        self.written - self.buf.len() as u64
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    /// Bytes written since absolute offset `since`.
    ///
    /// `None` when `since` fell out of the ring, and the caller has to send a
    /// whole snapshot and tell the client to clear. An empty vec means the
    /// client is already current, which is a different thing and has to stay
    /// different: conflating them is a terminal that repaints on every attach.
    pub fn delta_from(&self, since: u64) -> Option<Vec<u8>> {
        if since < self.start() || since > self.written {
            return None;
        }
        let skip = (since - self.start()) as usize;
        Some(self.buf.iter().skip(skip).copied().collect())
    }
}

impl Drop for Scrollback {
    fn drop(&mut self) {
        self.flush();
    }
}

impl Sink {
    fn append(&mut self, bytes: &[u8]) {
        if self.out.write_all(bytes).is_err() {
            return;
        }
        self.size += bytes.len() as u64;
        if self.size >= MAX_TRANSCRIPT_BYTES {
            self.roll();
        }
    }

    /// Moves the full file aside and starts a new one.
    ///
    /// One generation kept, so a thread's history is bounded by two files
    /// rather than by whoever remembers to clean the directory. A rename that
    /// fails leaves the file where it is and it keeps growing, which is the
    /// right way round: losing output is worse than using disk.
    fn roll(&mut self) {
        let previous = previous_path(&self.path);
        let _ = std::fs::remove_file(&previous);
        if std::fs::rename(&self.path, &previous).is_err() {
            return;
        }
        let Ok(file) = OpenOptions::new().create(true).append(true).open(&self.path) else {
            return;
        };
        self.out = file;
        self.size = 0;
    }
}

/// Where the previous generation of a transcript lives.
pub fn previous_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".1");
    path.with_file_name(name)
}

/// The transcript file for a thread, under a directory of them.
///
/// The id is checked rather than trusted: on the server it arrives from a
/// client, and a `..` in it would put the file wherever the caller liked.
pub fn path_for(dir: &Path, thread_id: &str) -> Option<PathBuf> {
    if thread_id.is_empty()
        || !thread_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(dir.join(format!("{thread_id}.log")))
}

/// The tail of a thread's transcript, as text somebody can read.
///
/// Reads from the end, because that is the question anybody actually has: what
/// was it doing when it stopped. The previous generation is read first when the
/// current one is shorter than what was asked for, so a roll-over in the middle
/// of a run does not cut the answer in half.
pub fn tail(dir: &Path, thread_id: &str, bytes: usize) -> Result<String, String> {
    let path = path_for(dir, thread_id).ok_or("that is not a thread id")?;
    let mut out = read_tail(&path, bytes)?;
    if out.len() < bytes {
        let mut earlier = read_tail(&previous_path(&path), bytes - out.len()).unwrap_or_default();
        earlier.extend_from_slice(&out);
        out = earlier;
    }
    Ok(plain(&out))
}

fn read_tail(path: &Path, bytes: usize) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|e| format!("no transcript: {e}"))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(bytes as u64);
    file.seek(SeekFrom::Start(from))
        .map_err(|e| format!("cannot read the transcript: {e}"))?;
    let mut buf = Vec::with_capacity(bytes.min(len as usize));
    file.read_to_end(&mut buf)
        .map_err(|e| format!("cannot read the transcript: {e}"))?;
    Ok(buf)
}

/// Terminal output with the escape sequences taken out.
///
/// Not a terminal emulator, and deliberately not: reconstructing the screen
/// would need a grid, and what this is for is reading and searching, where a
/// line that was overwritten is still worth having. Carriage returns are kept
/// as newlines for the same reason — a progress bar that redrew itself two
/// hundred times becomes two hundred lines, which is ugly and honest.
pub fn plain(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            match c {
                // A bare carriage return redrew the line; CRLF is one newline,
                // not two, which is most of what a Windows transcript is made
                // of.
                '\r' => {
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    out.push('\n');
                }
                // The C0 controls a reader has no use for. Tab and newline stay.
                c if (c as u32) < 0x20 && c != '\n' && c != '\t' => {}
                c => out.push(c),
            }
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates, then one final byte.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: runs to a BEL or an ST. This is where a title lives, and a
            // title is not part of what the terminal printed.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-character sequences, and anything else: drop the pair.
            _ => {}
        }
    }
    // A redrawn line leaves a run of empty lines behind it. One is enough, and
    // the trailing run is worth none at all.
    let mut kept: Vec<&str> = Vec::new();
    let mut blank = 0;
    for line in out.split('\n') {
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        kept.push(line);
    }
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    if kept.is_empty() {
        return String::new();
    }
    let mut squeezed = kept.join("\n");
    squeezed.push('\n');
    squeezed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_keeps_the_last_bytes_and_counts_them_all() {
        let mut s = Scrollback::new(8);
        s.extend(b"abcdefgh");
        assert_eq!(s.snapshot(), b"abcdefgh");
        assert_eq!(s.total(), 8);
        assert_eq!(s.start(), 0);

        s.extend(b"ijkl");
        assert_eq!(s.snapshot(), b"efghijkl");
        assert_eq!(s.total(), 12);
        assert_eq!(s.start(), 4);
    }

    /// A single write bigger than the ring keeps its own tail rather than
    /// draining one byte at a time.
    #[test]
    fn one_huge_write_keeps_its_own_tail() {
        let mut s = Scrollback::new(4);
        s.extend(b"abcdefghij");
        assert_eq!(s.snapshot(), b"ghij");
        assert_eq!(s.total(), 10);
    }

    /// The reason the offset exists: a reattaching client asks for what it has
    /// missed, not for the whole screen.
    #[test]
    fn a_client_that_is_current_gets_nothing_rather_than_a_repaint() {
        let mut s = Scrollback::new(16);
        s.extend(b"hello");
        assert_eq!(s.delta_from(5).unwrap(), b"");
        assert_eq!(s.delta_from(0).unwrap(), b"hello");
        s.extend(b" there");
        assert_eq!(s.delta_from(5).unwrap(), b" there");
    }

    /// And an offset that fell out of the ring has to be told apart from one
    /// that is current, because the answer is a full repaint rather than
    /// nothing.
    #[test]
    fn an_offset_that_fell_out_of_the_ring_is_not_an_empty_delta() {
        let mut s = Scrollback::new(4);
        s.extend(b"abcdefgh");
        assert_eq!(s.delta_from(0), None);
        assert_eq!(s.delta_from(9), None);
        assert_eq!(s.delta_from(4).unwrap(), b"efgh");
    }

    /// The reason the buffer is gone: a terminal that prints once and goes
    /// quiet is exactly the one somebody needs to read, and it is the one a
    /// size threshold or a deadline never reaches.
    #[test]
    fn one_line_is_on_disk_before_anything_else_happens() {
        let dir = scratch("immediate");
        let path = dir.join("t1.log");
        let mut s = Scrollback::new(64);
        assert!(s.to_file(&path));
        s.extend(b"said it once
");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "said it once
");
    }

    #[test]
    fn what_the_terminal_printed_survives_the_process() {
        let dir = scratch("survives");
        let path = dir.join("t1.log");
        {
            let mut s = Scrollback::new(4);
            assert!(s.to_file(&path));
            s.extend(b"the whole run, not the last four bytes");
        }
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, "the whole run, not the last four bytes");
    }

    /// A PTY that restarts is the same conversation. Truncating would lose
    /// exactly the part somebody is about to go looking for.
    #[test]
    fn a_respawn_appends_rather_than_starting_again() {
        let dir = scratch("append");
        let path = dir.join("t1.log");
        for line in ["first\n", "second\n"] {
            let mut s = Scrollback::new(64);
            s.to_file(&path);
            s.extend(line.as_bytes());
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
    }

    #[test]
    fn a_thread_id_cannot_choose_where_its_transcript_goes() {
        let dir = Path::new("/logs");
        assert!(path_for(dir, "../../etc/passwd").is_none());
        assert!(path_for(dir, "a/b").is_none());
        assert!(path_for(dir, "").is_none());
        assert_eq!(path_for(dir, "0f8c-4a").unwrap(), dir.join("0f8c-4a.log"));
    }

    #[test]
    fn the_tail_is_what_it_was_doing_when_it_stopped() {
        let dir = scratch("tail");
        {
            let mut s = Scrollback::new(4);
            s.to_file(&dir.join("t1.log"));
            s.extend(b"early output\nlate output\n");
        }
        let read = tail(&dir, "t1", 12).unwrap();
        assert!(read.ends_with("output\n"), "{read}");
        assert!(!read.contains("early"), "{read}");
        // And the whole thing when more is asked for than there is.
        assert!(tail(&dir, "t1", 1000).unwrap().contains("early output"));
        assert!(tail(&dir, "nothing-here", 10).is_err());
    }

    #[test]
    fn escape_sequences_are_not_part_of_what_was_printed() {
        // Colour, a cursor move, and a window title.
        let raw = b"\x1b[32mgreen\x1b[0m\x1b[2Kdone\x1b]0;a title\x07!";
        assert_eq!(plain(raw), "greendone!\n");
    }

    /// A progress bar redraws its line hundreds of times. Keeping each redraw
    /// as a line is ugly and honest; reconstructing the screen would need a
    /// terminal emulator, and a line that was overwritten is still worth
    /// having.
    #[test]
    fn a_redrawn_line_becomes_lines_rather_than_disappearing() {
        assert_eq!(plain(b"10%\r50%\r100%\r\n"), "10%\n50%\n100%\n");
    }

    #[test]
    fn a_wall_of_blank_lines_is_squeezed_to_one() {
        assert_eq!(plain(b"a\n\n\n\n\nb"), "a\n\nb\n");
    }

    #[test]
    fn broken_utf8_is_read_rather_than_refused() {
        assert!(plain(&[b'a', 0xff, 0xfe, b'b']).starts_with('a'));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "boite-transcript-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
