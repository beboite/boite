//! The answers a device may put into a terminal without typing them.
//!
//! **Writing bytes into a PTY is a remote code execution primitive.** Whatever
//! arrives is handed to whatever is at the prompt, and a phone answering a
//! notification is the least supervised caller Boite has. So this is not a thin
//! wrapper over `PtyManager::write`: the vocabulary is closed, every member is
//! one keystroke that a dialog is already asking for, and nothing in it can
//! carry a payload. There is no path from this module to an arbitrary byte.
//!
//! Two decisions worth the words:
//!
//! - **No implicit Enter.** `Yes`, `No` and a digit send their own character and
//!   nothing after it. Appending a newline would submit whatever is on the input
//!   line in the case the terminal did *not* read the keystroke as a menu
//!   selection, and the line an agent leaves behind is a half-typed prompt. That
//!   is the difference between answering a dialog and running something. `Enter`
//!   is its own answer for the prompts that need one.
//! - **No status gate.** A caller is not refused because the thread does not
//!   read `waiting` at that instant. Status is measured with a TTL, so gating on
//!   it would kill the one button that matters exactly when the measurement
//!   lagged. What makes the call safe is the vocabulary, not the timing.
//!
//! The other half of the bound is the door: this is reached over the desktop's
//! Tauri surface and the server's device-authenticated RPC, neither of which an
//! agent can call. It is deliberately **not** a command on the bus and not a
//! route on the agent endpoint. Answering a dialog is the user's move; an agent
//! that could answer its own permission prompts has no permission prompts.

/// One keystroke, from a closed set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reply {
    Yes,
    No,
    Enter,
    Escape,
    /// A numbered menu entry, 1 through 9.
    Choice(u8),
}

/// Every token this accepts, in the order the UI offers them. The frontend keeps
/// the same list in `src/lib/domain/awareness.json`, and a test below asserts
/// the two agree.
pub const TOKENS: &[&str] = &[
    "yes", "no", "enter", "escape", "1", "2", "3", "4", "5", "6", "7", "8", "9",
];

impl Reply {
    /// Parses a token, or refuses. The only way to build one from outside.
    pub fn parse(token: &str) -> Result<Reply, String> {
        match token {
            "yes" => Ok(Reply::Yes),
            "no" => Ok(Reply::No),
            "enter" => Ok(Reply::Enter),
            "escape" => Ok(Reply::Escape),
            _ => match token.as_bytes() {
                [digit @ b'1'..=b'9'] => Ok(Reply::Choice(digit - b'0')),
                _ => Err(format!(
                    "{token:?} is not an answer a terminal takes from here"
                )),
            },
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Reply::Yes => "yes",
            Reply::No => "no",
            Reply::Enter => "enter",
            Reply::Escape => "escape",
            // `Choice` is a public variant, so the payload is not guaranteed to
            // have come through `parse`; clamp rather than index out of bounds.
            Reply::Choice(n) => TOKENS[(n.clamp(1, 9) as usize) + 3],
        }
    }

    /// What goes down the wire. Every arm is a compile-time constant, which is
    /// the property this module is for.
    pub fn bytes(self) -> &'static [u8] {
        match self {
            Reply::Yes => b"y",
            Reply::No => b"n",
            Reply::Enter => b"\r",
            Reply::Escape => b"\x1b",
            Reply::Choice(n) => match n {
                1 => b"1",
                2 => b"2",
                3 => b"3",
                4 => b"4",
                5 => b"5",
                6 => b"6",
                7 => b"7",
                8 => b"8",
                9 => b"9",
                // Unreachable through `parse`, and a panic here would be a way
                // to take a terminal down from a query string.
                _ => b"",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_token_round_trips_and_nothing_else_parses() {
        for token in TOKENS {
            let reply = Reply::parse(token).expect(token);
            assert_eq!(reply.as_str(), *token);
            assert!(!reply.bytes().is_empty(), "{token}");
        }
        for bad in [
            "",
            "Y",
            "yes\r",
            "0",
            "10",
            "rm -rf /",
            "\r",
            "y",
            "escape ",
            "ENTER",
            "\u{1b}[A",
        ] {
            assert!(Reply::parse(bad).is_err(), "{bad:?} must not parse");
        }
    }

    /// The property the whole module exists for: nothing reachable through
    /// `parse` writes more than one keystroke, and no answer submits a line on
    /// its own except the one whose name says it does.
    #[test]
    fn no_answer_can_carry_a_payload() {
        for token in TOKENS {
            let bytes = Reply::parse(token).unwrap().bytes();
            assert_eq!(bytes.len(), 1, "{token} is more than one byte");
            if *token != "enter" {
                assert!(
                    !bytes.contains(&b'\r') && !bytes.contains(&b'\n'),
                    "{token} submits a line"
                );
            }
        }
        assert_eq!(Reply::Enter.bytes(), b"\r");
        assert_eq!(Reply::Escape.bytes(), b"\x1b");
    }

    #[test]
    fn the_shared_table_offers_the_same_answers() {
        let raw = include_str!("../../../src/lib/domain/awareness.json");
        let table: serde_json::Value = serde_json::from_str(raw).expect("awareness.json parses");
        let listed: Vec<&str> = table["replies"]
            .as_array()
            .expect("replies is an array")
            .iter()
            .map(|v| v.as_str().expect("a reply token is a string"))
            .collect();
        assert_eq!(listed, TOKENS);
    }
}
