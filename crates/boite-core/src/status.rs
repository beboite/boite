// Server-side thread status derivation. In remote mode the server owns this so
// disconnected clients and the thread list stay correct.
//
// Status here is driven by the OSC title the agents emit: a leading marker glyph
// means "working" (running); a clean title means idle (ready). The desktop no
// longer works this way: it reads the emulator's live rows, and asks claude's
// own session registry first, because it has an emulator and the thread's
// session id, and the server has neither. See the "Status is measured, never
// latched" section of AGENTS.md.

// Leading marker glyphs the AI CLIs cycle through while working, plus the
// braille/circle spinner frames some emit in the title.
const WORKING_GLYPHS: &[char] = &[
    '✱', '✻', '✦', '✺', '✧', '✨', '✳', '❖', '✷', '✴', '✵', '◐', '◓', '◑', '◒', '⏳',
];

/// Working marker: the explicit glyph set plus any non-blank braille spinner
/// frame (grok cycles frames well beyond the common ⠋…⠏ subset). ⚠ and ✓
/// (hermes: action required / idle) are deliberately not working markers,
/// but strip_leading_marker still drops them from the label.
fn is_working_glyph(c: char) -> bool {
    WORKING_GLYPHS.contains(&c) || ('\u{2801}'..='\u{28FF}').contains(&c)
}

/// True when the OSC title signals the agent is actively working.
pub fn title_signals_working(title: &str) -> bool {
    title.chars().any(is_working_glyph)
}

/// Drop a leading marker glyph (and the whitespace after it) so the sidebar
/// label stays readable.
pub fn strip_leading_marker(title: &str) -> String {
    let trimmed = title.trim_start();
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) if is_working_glyph(first) || first == '✓' || first == '⚠' => {
            chars.as_str().trim_start().to_string()
        }
        _ => trimmed.to_string(),
    }
}

// OSC titles the CLIs emit by default that just restate the brand; ignoring
// them keeps the user's thread label ("Claude #1") instead of "claude".
const GENERIC_TITLES: &[&str] = &[
    // A launcher naming itself before it knows what it launched: the Windows PTY
    // titles the thread with fastpick's own image path, which would replace the
    // agent's name with `…\.local\bin\fastpick.exe`.
    "fastpick",
    "claude",
    "claude code",
    "claude-code",
    "anthropic",
    "codex",
    "openai codex",
    "chatgpt",
    "opencode",
    "cursor",
    "cursor-agent",
    "cursor agent",
    "gemini",
    "google gemini",
    "antigravity",
    "agy",
    "google antigravity",
    "copilot",
    "github copilot",
    "gh copilot",
    "grok",
    "xai",
    "hermes",
    "hermes agent",
    "nous research",
    "pi",
    "pi coding agent",
    "muse",
    "muse code",
    "meta",
    "powershell",
    "powershell 7",
    "pwsh",
    "windows powershell",
    "bash",
    "zsh",
    "sh",
    "fish",
    "nu",
    "nushell",
    "cmd",
    "cmd.exe",
    "command prompt",
    "terminal",
];

/// True for titles that merely restate the tool/shell name.
pub fn is_generic_title(title: &str) -> bool {
    let direct = title.trim().to_lowercase();
    if direct.is_empty() {
        return false;
    }
    if GENERIC_TITLES.contains(&direct.as_str()) {
        return true;
    }
    if let Some(base) = normalize_shell_path(title) {
        if GENERIC_TITLES.contains(&base.as_str()) {
            return true;
        }
    }
    false
}

/// True when the title is just the project directory basename. Codex's
/// default terminal_title is spinner + project dir, which would name every
/// thread in a project after its folder.
pub fn is_project_dir_title(title: &str, cwd: &str) -> bool {
    let dir = cwd.replace('\\', "/");
    let dir = dir.trim_end_matches('/');
    let Some(name) = dir.rsplit('/').next() else {
        return false;
    };
    if name.is_empty() {
        return false;
    }
    title.trim().to_lowercase() == name.to_lowercase()
}

fn normalize_shell_path(title: &str) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Drop "Administrator: " / "User: " prefixes cmd.exe prepends.
    let body = match trimmed.find(": ") {
        Some(colon) if colon < 32 => &trimmed[colon + 2..],
        _ => trimmed,
    };
    let last_slash = body.rfind(['\\', '/'])?;
    let mut base = body[last_slash + 1..].trim().to_string();
    if base.is_empty() {
        return None;
    }
    if base.to_lowercase().ends_with(".exe") {
        base.truncate(base.len() - 4);
    }
    Some(base.to_lowercase())
}

/// Persisted thread status values, matching the frontend ThreadStatus union.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadStatus {
    Idle,
    Running,
    /// Blocked on the user. Distinct from Ready, which means the agent has nothing
    /// left to do: this one has a turn in flight that only an answer will finish,
    /// so it is never a candidate for auto-sleep and it is worth telling the user
    /// about. Only claude declares it (`waiting` in its session registry).
    Waiting,
    Ready,
    Done,
    Exited,
    Error,
    Stopped,
}

impl ThreadStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadStatus::Idle => "idle",
            ThreadStatus::Running => "running",
            ThreadStatus::Waiting => "waiting",
            ThreadStatus::Ready => "ready",
            ThreadStatus::Done => "done",
            ThreadStatus::Exited => "exited",
            ThreadStatus::Error => "error",
            ThreadStatus::Stopped => "stopped",
        }
    }

    /// The inverse of [`ThreadStatus::as_str`], for the paths that carry a
    /// status as the string a row or an event holds. `None` for anything else,
    /// which is a client or a database from a build that knows a status this one
    /// does not.
    pub fn parse(s: &str) -> Option<ThreadStatus> {
        match s {
            "idle" => Some(ThreadStatus::Idle),
            "running" => Some(ThreadStatus::Running),
            "waiting" => Some(ThreadStatus::Waiting),
            "ready" => Some(ThreadStatus::Ready),
            "done" => Some(ThreadStatus::Done),
            "exited" => Some(ThreadStatus::Exited),
            "error" => Some(ThreadStatus::Error),
            "stopped" => Some(ThreadStatus::Stopped),
            _ => None,
        }
    }

    /// Map a PTY exit code to a terminal status.
    pub fn from_exit_code(code: Option<i32>) -> ThreadStatus {
        match code {
            Some(0) => ThreadStatus::Done,
            _ => ThreadStatus::Exited,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_glyphs_signal_working() {
        for glyph in WORKING_GLYPHS {
            let title = format!("{glyph} Refactoring the parser");
            assert!(
                title_signals_working(&title),
                "{glyph} should signal working"
            );
        }
    }

    #[test]
    fn any_braille_spinner_frame_signals_working() {
        // grok cycles well past the common ⠋…⠏ subset, which is why the check
        // is a range and not a list.
        for frame in ['\u{2801}', '\u{280B}', '\u{28FF}', '\u{2847}'] {
            assert!(title_signals_working(&format!("{frame} thinking")));
        }
        // U+2800 is blank braille: padding, not a spinner frame.
        assert!(!title_signals_working("\u{2800} idle"));
    }

    #[test]
    fn clean_title_does_not_signal_working() {
        assert!(!title_signals_working("Refactoring the parser"));
        assert!(!title_signals_working(""));
    }

    #[test]
    fn hermes_markers_are_stripped_but_are_not_working() {
        // Regression: ✓/⚠ mean "idle"/"action required". Treating them as
        // working left a permanently pulsing dot on an idle thread.
        assert!(!title_signals_working("✓ done"));
        assert!(!title_signals_working("⚠ needs input"));
        assert_eq!(strip_leading_marker("✓ done"), "done");
        assert_eq!(strip_leading_marker("⚠ needs input"), "needs input");
    }

    #[test]
    fn strip_leading_marker_only_touches_the_first_glyph() {
        assert_eq!(strip_leading_marker("✱ Building"), "Building");
        assert_eq!(strip_leading_marker("   ✻   Building"), "Building");
        assert_eq!(strip_leading_marker("Building ✱"), "Building ✱");
        assert_eq!(strip_leading_marker("Building"), "Building");
        assert_eq!(strip_leading_marker(""), "");
    }

    #[test]
    fn brand_titles_are_generic() {
        for title in ["claude", "Claude Code", "  PWSH  ", "cmd.exe", "Terminal"] {
            assert!(is_generic_title(title), "{title} should be generic");
        }
    }

    #[test]
    fn shell_paths_normalize_to_their_binary_name() {
        assert!(is_generic_title("C:\\Program Files\\PowerShell\\7\\pwsh.exe"));
        assert!(is_generic_title("/usr/bin/zsh"));
        // fastpick titles the thread with its own path before the agent it
        // launched gets to name it.
        assert!(is_generic_title("C:\\Users\\nuno\\.local\\bin\\fastpick.exe"));
        assert!(is_generic_title("/home/nuno/.local/bin/fastpick"));
        // cmd.exe prepends an elevation prefix.
        assert!(is_generic_title("Administrator: C:\\Windows\\system32\\cmd.exe"));
    }

    #[test]
    fn real_work_titles_are_not_generic() {
        assert!(!is_generic_title("Fixing the PTY read loop"));
        assert!(!is_generic_title(""));
        assert!(!is_generic_title("   "));
        // A path whose basename is not a known shell must survive.
        assert!(!is_generic_title("/usr/local/bin/boite"));
    }

    #[test]
    fn project_dir_titles_are_detected_across_separators() {
        assert!(is_project_dir_title("boite", "D:\\Dev\\Collab\\boite"));
        assert!(is_project_dir_title("BOITE", "/home/nuno/boite"));
        assert!(is_project_dir_title("boite", "/home/nuno/boite/"));
        assert!(!is_project_dir_title("boite", "/home/nuno/other"));
        assert!(!is_project_dir_title("", "/home/nuno/boite"));
        assert!(!is_project_dir_title("boite", "/"));
    }

    #[test]
    fn exit_code_maps_to_terminal_status() {
        assert_eq!(ThreadStatus::from_exit_code(Some(0)), ThreadStatus::Done);
        assert_eq!(ThreadStatus::from_exit_code(Some(1)), ThreadStatus::Exited);
        assert_eq!(ThreadStatus::from_exit_code(Some(-1)), ThreadStatus::Exited);
        // Killed by a signal: no code, still not a clean exit.
        assert_eq!(ThreadStatus::from_exit_code(None), ThreadStatus::Exited);
    }

    #[test]
    fn status_strings_match_the_frontend_union() {
        // These strings are persisted in SQLite and parsed by the client's
        // ThreadStatus union; renaming one silently breaks restored threads.
        assert_eq!(ThreadStatus::Idle.as_str(), "idle");
        assert_eq!(ThreadStatus::Running.as_str(), "running");
        assert_eq!(ThreadStatus::Waiting.as_str(), "waiting");
        assert_eq!(ThreadStatus::Ready.as_str(), "ready");
        assert_eq!(ThreadStatus::Done.as_str(), "done");
        assert_eq!(ThreadStatus::Exited.as_str(), "exited");
        assert_eq!(ThreadStatus::Error.as_str(), "error");
        assert_eq!(ThreadStatus::Stopped.as_str(), "stopped");
    }

    #[test]
    fn every_status_parses_back_out_of_its_own_string() {
        for status in [
            ThreadStatus::Idle,
            ThreadStatus::Running,
            ThreadStatus::Waiting,
            ThreadStatus::Ready,
            ThreadStatus::Done,
            ThreadStatus::Exited,
            ThreadStatus::Error,
            ThreadStatus::Stopped,
        ] {
            assert_eq!(ThreadStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(ThreadStatus::parse("sleeping"), None);
        assert_eq!(ThreadStatus::parse("Running"), None);
        assert_eq!(ThreadStatus::parse(""), None);
    }
}
