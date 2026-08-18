//! Printing. The same four colours the PowerShell version used, and the same
//! rule about when to drop them: a terminal that says no gets plain text.

use std::io::Write;
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Color {
    Plain,
    Red,
    Green,
    Yellow,
    Cyan,
    Dim,
}

fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        use std::io::IsTerminal;
        // A slash command, a hook and a pipe all read this output as text, and
        // escape codes in it are noise rather than colour.
        std::io::stdout().is_terminal()
            && std::env::var_os("NO_COLOR").is_none()
            && std::env::var("TERM").map(|t| t != "dumb").unwrap_or(true)
    })
}

impl Color {
    fn code(self) -> Option<&'static str> {
        match self {
            Color::Plain => None,
            Color::Red => Some("31"),
            Color::Green => Some("32"),
            Color::Yellow => Some("33"),
            Color::Cyan => Some("36"),
            Color::Dim => Some("2"),
        }
    }
}

pub fn paint(text: &str, color: Color) -> String {
    match color.code() {
        Some(code) if enabled() => format!("\x1b[{code}m{text}\x1b[0m"),
        _ => text.to_string(),
    }
}

pub fn say(text: &str, color: Color) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", paint(text, color));
}

/// A question on stdout and a line back from stdin. Returns an empty string
/// when there is nothing on stdin, which is what an unattended run gets.
pub fn ask(question: &str) -> String {
    let mut out = std::io::stdout().lock();
    let _ = write!(out, "{question}: ");
    let _ = out.flush();
    drop(out);
    let mut line = String::new();
    match std::io::stdin().read_line(&mut line) {
        Ok(_) => line.trim().to_string(),
        Err(_) => String::new(),
    }
}

pub fn said_yes(answer: &str) -> bool {
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}
