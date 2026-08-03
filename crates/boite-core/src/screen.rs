//! What is on the window, in words.
//!
//! The last thing an agent had to ask a human for. Everything else about a
//! broken Boite is answerable from here: the rows say what exists, `livePtys`
//! says what is running, the transcripts say what was printed and the timeline
//! says in what order. "Which panes are open, how big are they, and what is
//! covering them" was answerable only by somebody looking at the screen.
//!
//! **Why this is not a screenshot.** An image has to be looked at, costs a few
//! hundred kilobytes of context, and answers "there is a dark rectangle here"
//! when the question is "is the git pane open and does it have any width". The
//! window already knows the answer in words, so it says it in words.
//!
//! **Why the window pushes rather than being asked.** Asking means a round trip
//! into a webview that may be the thing that is broken, and a call that hangs
//! when the answer matters most. The window describes itself when its layout
//! changes and on a slow beat otherwise, and [`Screen::at`] is part of the
//! answer: a description that stopped being refreshed is itself the diagnosis,
//! and it is one nothing else in the app can report.
//!
//! **Why it is not a dev-only surface.** A generic desktop bridge inspects an
//! app it knows nothing about, in an instance it started itself, which is never
//! the instance the bug is in. This one is the running workspace describing
//! itself in its own vocabulary, so it ships with the app and answers for
//! whichever window is actually open.

use serde::{Deserialize, Serialize};

/// Where something is, in CSS pixels off the top left of the window.
///
/// Measured rather than derived from the layout tree: the tree holds ratios, and
/// the question being asked is usually about the difference between the two. A
/// pane with a ratio of 0.3 and a width of 4 pixels is exactly the bug this
/// makes visible.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    /// Whether anything of it can be seen. A pane measured at no width is on the
    /// layout and not on the screen, which is a difference no list of open panes
    /// would show.
    pub fn shows(&self) -> bool {
        self.w >= 1.0 && self.h >= 1.0
    }
}

/// One pane, as the window has it laid out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub id: String,
    /// `thread`, `git`, `explorer`, `todo`, `editor`, `browser`, `dashboard`.
    pub kind: String,
    /// What the pane's own header says, which is what the user would name it.
    pub title: String,
    /// The terminal in it, for a pane that holds one. This is what joins a pane
    /// to a thread row, to a live PTY and to a transcript.
    pub thread_id: Option<String>,
    pub rect: Rect,
    pub focused: bool,
}

/// The window itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub width: f32,
    pub height: f32,
    /// Whether the window has the operating system's focus. A workspace nobody
    /// is looking at explains a report about something not updating.
    pub focused: bool,
}

/// What the window says is on it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    /// When the window last described itself. Compare with a snapshot's
    /// `takenAtMs`: a gap of more than a few seconds means the window stopped
    /// answering, which is a diagnosis rather than a missing field.
    pub at: i64,
    /// The project whose group is on screen.
    pub project_id: String,
    pub window: Window,
    /// In reading order, left to right and top to bottom.
    pub panes: Vec<Pane>,
    /// What is over the layout: an open modal, an approval card waiting, the
    /// command palette, a toast. Named by what they are rather than counted,
    /// because "a dialog is open" answers most reports of a window that has
    /// stopped responding to anything.
    pub overlays: Vec<String>,
}

/// The most panes and overlays that are ever carried.
///
/// The window sends this, and the window is the half that may be misbehaving. A
/// bound here means a runaway layout is reported as a long list rather than
/// arriving as an answer nothing can hold.
pub const MAX_PANES: usize = 32;
pub const MAX_OVERLAYS: usize = 16;

impl Screen {
    /// Trims whatever the window sent to something worth keeping.
    ///
    /// Called on the way in, not on the way out: what is stored is already
    /// bounded, so a window that went wrong cannot grow this without bound in a
    /// process that is otherwise fine.
    pub fn trimmed(mut self) -> Screen {
        self.panes.truncate(MAX_PANES);
        self.overlays.truncate(MAX_OVERLAYS);
        for pane in &mut self.panes {
            if pane.title.chars().count() > 120 {
                pane.title = pane.title.chars().take(120).collect();
            }
        }
        self
    }

    /// One line per pane, for a reader that has no window of its own.
    ///
    /// Rounded to whole pixels: nobody is measuring, and a fractional width in
    /// every line makes the one line that says `0x0` harder to find.
    pub fn lines(&self) -> Vec<String> {
        self.panes
            .iter()
            .map(|p| {
                format!(
                    "{}{} {} at {}x{} ({},{}){}",
                    if p.focused { "* " } else { "  " },
                    p.kind,
                    p.title,
                    p.rect.w.round(),
                    p.rect.h.round(),
                    p.rect.x.round(),
                    p.rect.y.round(),
                    if p.rect.shows() {
                        ""
                    } else {
                        " -- laid out but not visible"
                    },
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str, w: f32, focused: bool) -> Pane {
        Pane {
            id: id.into(),
            kind: "thread".into(),
            title: id.into(),
            thread_id: Some(id.into()),
            rect: Rect {
                x: 0.0,
                y: 0.0,
                w,
                h: 600.0,
            },
            focused,
        }
    }

    fn screen(panes: Vec<Pane>) -> Screen {
        Screen {
            at: 1,
            project_id: "p1".into(),
            window: Window {
                width: 1280.0,
                height: 720.0,
                focused: true,
            },
            panes,
            overlays: Vec::new(),
        }
    }

    /// The difference this exists to show: a pane that is open and has no width
    /// is not the same thing as a pane that is closed, and a list of open panes
    /// cannot tell them apart.
    #[test]
    fn a_pane_with_no_width_is_reported_as_not_visible() {
        let s = screen(vec![pane("a", 640.0, true), pane("b", 0.0, false)]);
        let lines = s.lines();
        assert!(lines[0].starts_with("* thread a at 640x600"), "{:?}", lines[0]);
        assert!(lines[1].contains("not visible"), "{:?}", lines[1]);
        assert!(!lines[0].contains("not visible"));
    }

    /// The window is the half that may be misbehaving, so what it sends is
    /// bounded before it is kept.
    #[test]
    fn a_runaway_window_cannot_grow_this_without_bound() {
        let many: Vec<Pane> = (0..100).map(|i| pane(&format!("p{i}"), 10.0, false)).collect();
        let mut s = screen(many);
        s.overlays = (0..100).map(|i| format!("o{i}")).collect();
        s.panes[0].title = "x".repeat(500);

        let s = s.trimmed();
        assert_eq!(s.panes.len(), MAX_PANES);
        assert_eq!(s.overlays.len(), MAX_OVERLAYS);
        assert_eq!(s.panes[0].title.chars().count(), 120);
    }

    #[test]
    fn what_the_window_sent_survives_a_round_trip() {
        let s = screen(vec![pane("a", 640.0, true)]);
        let text = serde_json::to_string(&s).unwrap();
        // camelCase on the wire, because the other end of this is a webview.
        assert!(text.contains("\"projectId\""), "{text}");
        assert!(text.contains("\"threadId\""), "{text}");
        let back: Screen = serde_json::from_str(&text).unwrap();
        assert_eq!(back.panes.len(), 1);
        assert_eq!(back.panes[0].id, "a");
        assert!(back.window.focused);
    }
}
