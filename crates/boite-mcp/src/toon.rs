//! Token-Optimized Object Notation: what this shim answers in, instead of JSON.
//!
//! Every byte here lands in a model's context window, and pretty-printed JSON
//! spends most of them on punctuation and on repeating each key once per row.
//! The same list in TOON costs roughly 40% less and reads the same way:
//!
//! ```text
//! todos(2):
//!   id state text
//!   1a5f3698 open "opti mcp axi"
//!   596ce966 claimed "readme"
//! hint: todo_claim id=<id> note=<what changed>
//! ```
//!
//! Values that could be read as structure — anything with a space, a colon, a
//! leading dash, or that spells a literal — get quoted. Everything else goes
//! out bare.

use std::fmt::Write;

pub struct Toon {
    buf: String,
}

impl Toon {
    pub fn new() -> Self {
        Self { buf: String::new() }
    }

    pub fn into_string(self) -> String {
        self.buf
    }

    /// A missing value prints as `-`, the same mark an empty cell gets. `""` is
    /// a value here; nothing at all is not, and the two should not read alike.
    pub fn field(&mut self, key: &str, value: &str) -> &mut Self {
        self.buf.push_str(key);
        self.buf.push_str(": ");
        if value.is_empty() {
            self.buf.push('-');
        } else {
            escape_into(value, &mut self.buf);
        }
        self.buf.push('\n');
        self
    }

    pub fn flag(&mut self, key: &str, value: bool) -> &mut Self {
        let _ = writeln!(self.buf, "{key}: {value}");
        self
    }

    /// `key(N):` followed by a header row and one row per item, two spaces in.
    /// An empty table says so on one line rather than printing a header nobody
    /// can use — an agent reading `todos(0): empty` knows it asked a valid
    /// question and got a real answer, which an empty block never conveys.
    pub fn table(&mut self, key: &str, cols: &[&str], rows: &[Vec<String>]) -> &mut Self {
        if rows.is_empty() {
            let _ = writeln!(self.buf, "{key}(0): empty");
            return self;
        }
        let _ = writeln!(self.buf, "{key}({}):", rows.len());
        self.row(cols.iter().copied());
        for r in rows {
            self.row(r.iter().map(String::as_str));
        }
        self
    }

    fn row<'a>(&mut self, cells: impl Iterator<Item = &'a str>) {
        self.buf.push_str("  ");
        for (i, cell) in cells.enumerate() {
            if i > 0 {
                self.buf.push(' ');
            }
            if cell.is_empty() {
                self.buf.push('-');
            } else {
                escape_into(cell, &mut self.buf);
            }
        }
        self.buf.push('\n');
    }

    /// A one-dimensional list on a single line: `key(N): a b c`. Cheaper than a
    /// table when there is only ever one column.
    pub fn inline(&mut self, key: &str, items: &[String], cap: usize) -> &mut Self {
        if items.is_empty() {
            let _ = writeln!(self.buf, "{key}(0): empty");
            return self;
        }
        let _ = write!(self.buf, "{key}({}):", items.len());
        for item in items.iter().take(cap) {
            self.buf.push(' ');
            escape_into(item, &mut self.buf);
        }
        if items.len() > cap {
            let _ = write!(self.buf, " …+{}", items.len() - cap);
        }
        self.buf.push('\n');
        self
    }

    /// The next call the agent is likely to want. Cheap here, and it saves the
    /// round trip where a model asks the list what its own arguments are.
    pub fn hint(&mut self, msg: &str) -> &mut Self {
        self.buf.push_str("hint: ");
        self.buf.push_str(msg);
        self.buf.push('\n');
        self
    }
}

/// Keep the head of an overlong value and say how much was cut, so a todo whose
/// text is a pasted paragraph costs a line instead of a page.
pub fn clip(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…[+{}B]", &text[..cut], text.len() - cut)
}

fn escape_into(s: &str, buf: &mut String) {
    if !needs_quote(s) {
        buf.push_str(s);
        return;
    }
    buf.push('"');
    for c in s.chars() {
        match c {
            '"' => buf.push_str("\\\""),
            '\\' => buf.push_str("\\\\"),
            '\n' => buf.push_str("\\n"),
            '\r' => buf.push_str("\\r"),
            '\t' => buf.push_str("\\t"),
            _ => buf.push(c),
        }
    }
    buf.push('"');
}

fn needs_quote(s: &str) -> bool {
    if s.is_empty() || s.starts_with('-') {
        return true;
    }
    if s.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '"' | '\\' | ':' | '#')) {
        return true;
    }
    matches!(s, "true" | "false" | "null")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalars_quote_only_when_ambiguous() {
        let mut t = Toon::new();
        t.field("branch", "feat/x").field("text", "opti mcp axi");
        assert_eq!(t.into_string(), "branch: feat/x\ntext: \"opti mcp axi\"\n");
    }

    #[test]
    fn windows_paths_survive_quoting() {
        let mut t = Toon::new();
        t.field("path", r"C:\Users\a b\repo");
        assert_eq!(t.into_string(), "path: \"C:\\\\Users\\\\a b\\\\repo\"\n");
    }

    #[test]
    fn empty_table_says_so() {
        let mut t = Toon::new();
        t.table("todos", &["id"], &[]);
        assert_eq!(t.into_string(), "todos(0): empty\n");
    }

    #[test]
    fn table_counts_and_marks_missing_cells() {
        let mut t = Toon::new();
        t.table(
            "todos",
            &["id", "state", "note"],
            &[vec!["1a5f".into(), "open".into(), String::new()]],
        );
        assert_eq!(t.into_string(), "todos(1):\n  id state note\n  1a5f open -\n");
    }

    #[test]
    fn inline_list_caps_and_counts() {
        let mut t = Toon::new();
        let items: Vec<String> = (0..5).map(|i| format!("b{i}")).collect();
        t.inline("branches", &items, 3);
        assert_eq!(t.into_string(), "branches(5): b0 b1 b2 …+2\n");
    }

    #[test]
    fn clip_keeps_head_and_reports_the_rest() {
        assert_eq!(clip("short", 32), "short");
        let long = "a".repeat(100);
        assert_eq!(clip(&long, 10), format!("{}…[+90B]", "a".repeat(10)));
    }

    #[test]
    fn clip_never_splits_a_codepoint() {
        // 'é' is two bytes: cutting at 3 has to fall back to 2.
        assert_eq!(clip("aéb", 3), "aé…[+1B]");
    }
}
