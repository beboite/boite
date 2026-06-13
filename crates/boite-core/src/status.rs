// Server-side thread status derivation. The desktop runs an equivalent engine
// in TypeScript (features/thread/statusEngine.ts); in remote mode the server
// owns this so disconnected clients and the thread list stay correct.
//
// Status is driven by the OSC title Claude Code emits: a leading marker glyph
// means "working" (running); a clean title means idle (ready). See the
// "Status detection" section of the project CLAUDE.md.

// Leading marker glyphs the AI CLIs cycle through while working, plus the
// braille/circle spinner frames some emit in the title.
const WORKING_GLYPHS: &[char] = &[
    '✱', '✻', '✦', '✺', '✧', '✨', '✳', '❖', '✷', '✴', '✵', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦',
    '⠧', '⠇', '⠏', '◐', '◓', '◑', '◒',
];

/// True when the OSC title signals the agent is actively working.
pub fn title_signals_working(title: &str) -> bool {
    title.chars().any(|c| WORKING_GLYPHS.contains(&c))
}

/// Drop a leading working glyph (and the whitespace after it) so the sidebar
/// label stays readable.
pub fn strip_leading_marker(title: &str) -> String {
    let trimmed = title.trim_start();
    let mut chars = trimmed.chars();
    match chars.next() {
        Some(first) if WORKING_GLYPHS.contains(&first) => chars.as_str().trim_start().to_string(),
        _ => trimmed.to_string(),
    }
}

// OSC titles the CLIs emit by default that just restate the brand; ignoring
// them keeps the user's thread label ("Claude #1") instead of "claude".
const GENERIC_TITLES: &[&str] = &[
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
            ThreadStatus::Ready => "ready",
            ThreadStatus::Done => "done",
            ThreadStatus::Exited => "exited",
            ThreadStatus::Error => "error",
            ThreadStatus::Stopped => "stopped",
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
