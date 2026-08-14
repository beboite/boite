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
///
/// The three browser fields carry `#[serde(default)]` and the others do not,
/// which is not tidiness: a boite serves its own SPA and a device can be running
/// a cached older build of it. A field added without a default turns that
/// device's whole description into a deserialize error, so the window stops
/// answering the moment it has something new to say.
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
    /// The page in it, for a pane that holds one. What `thread_id` is to a
    /// terminal: the only thing that joins the rectangle to what is in it.
    ///
    /// It is the address the app framed, never the address the frame is on now.
    /// The two part company the moment anything inside the page navigates, and
    /// nothing on this side can tell: see [`PAGE_IS_OPAQUE`].
    #[serde(default)]
    pub url: Option<String>,
    /// What the frame's own `load` event said. One of [`PAGE_STATES`].
    ///
    /// The whole of what the container observes about a page. `stalled` is not
    /// "failed": a frame that never fires `load` is either slow or refused by
    /// `X-Frame-Options`, and the error goes to the console of a document the
    /// app is not allowed to touch.
    #[serde(default)]
    pub page: Option<String>,
    /// The thread whose agent is pointing this pane, until the user takes it
    /// back. `None` is a pane the user owns, and an agent's calls at one are
    /// refused rather than queued.
    #[serde(default)]
    pub driven_by: Option<String>,
    pub rect: Rect,
    pub focused: bool,
}

/// What the window can say about a page, and the whole of it.
pub const PAGE_STATES: [&str; 3] = ["loading", "loaded", "stalled"];

/// Why nothing *here* describes what is in a page, and where that answer lives.
///
/// The browser pane is a sandboxed cross-origin `<iframe>`, and both halves of
/// that are load bearing. `crate::browser::classify` refuses Boite's own origin
/// outright, so the frame is never same-origin with the window; and everything
/// that is not a dev server on this machine also loses `allow-same-origin`, so
/// it lands in an opaque origin. The app's own scripts read nothing across that
/// boundary, which is why this description carries an address and a load state
/// and no more.
///
/// Reading the page is a different door: on a desktop window the webview
/// itself injects a driver into every frame (an initialization script, below
/// the page's origin machinery rather than across it), and the snapshot,
/// click and type tools talk to that. A pane drawn by a plain browser or a
/// phone has no such door, and the sentence below is what those hosts still
/// have to say.
pub const PAGE_IS_OPAQUE: &str = "the page is a sandboxed cross-origin frame: this description \
                                  carries its address and whether it loaded, nothing more. \
                                  browser_snapshot reads inside it when the pane is on a Boite \
                                  desktop window";

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
/// Long enough for a real address with a query on it, short enough that a
/// window sending thirty-two of them cannot fill an answer on its own.
pub const MAX_URL: usize = 300;

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
            if pane.url.as_ref().is_some_and(|u| u.chars().count() > MAX_URL) {
                pane.url = pane.url.as_ref().map(|u| u.chars().take(MAX_URL).collect());
            }
            // A word this does not know is dropped rather than passed on. An
            // agent reading an unlisted state has no way to act on it, and
            // "nothing was said" is the answer it already handles.
            if pane.page.as_deref().is_some_and(|p| !PAGE_STATES.contains(&p)) {
                pane.page = None;
            }
        }
        self
    }

    /// The browser panes, in reading order. What every browser tool asks first.
    pub fn browsers(&self) -> Vec<&Pane> {
        self.panes.iter().filter(|p| p.kind == "browser").collect()
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
                    "{}{} {} at {}x{} ({},{}){}{}",
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
                    // The address belongs on the line for the same reason the
                    // size does: "a browser pane is open" and "it is open on
                    // the page you meant" are different answers.
                    match (&p.url, &p.page) {
                        (Some(url), Some(state)) => format!(" -- {state} {url}"),
                        (Some(url), None) => format!(" -- {url}"),
                        _ => String::new(),
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
            url: None,
            page: None,
            driven_by: None,
        }
    }

    fn browser(id: &str, url: &str, page: Option<&str>) -> Pane {
        Pane {
            kind: "browser".into(),
            url: Some(url.into()),
            page: page.map(str::to_string),
            ..pane(id, 640.0, false)
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

    /// "A browser pane is open" and "it is open on the page you meant" are two
    /// answers, and only the second one is worth reading.
    #[test]
    fn a_browser_pane_says_where_it_points_and_how_it_went() {
        let s = screen(vec![browser("b1", "http://localhost:5173/", Some("loaded"))]);
        assert!(s.lines()[0].ends_with(" -- loaded http://localhost:5173/"), "{:?}", s.lines()[0]);
        assert_eq!(s.browsers().len(), 1);
        assert!(screen(vec![pane("a", 10.0, false)]).browsers().is_empty());
    }

    /// The window is the half that may be misbehaving, and a state nothing can
    /// act on is worse than no state at all.
    #[test]
    fn a_page_state_this_does_not_know_is_dropped() {
        let s = screen(vec![
            browser("b1", "http://localhost:1/", Some("on fire")),
            browser("b2", &format!("http://localhost:2/?q={}", "x".repeat(500)), Some("loaded")),
        ])
        .trimmed();
        assert_eq!(s.panes[0].page, None);
        assert_eq!(s.panes[1].page.as_deref(), Some("loaded"));
        assert_eq!(s.panes[1].url.as_ref().unwrap().chars().count(), MAX_URL);
    }

    /// A device can be running a cached older build of the SPA, and its
    /// description has to stay readable rather than becoming a parse error.
    #[test]
    fn a_window_that_never_heard_of_browser_panes_still_describes_itself() {
        let older = r#"{"id":"a","kind":"git","title":"Git","threadId":null,
            "rect":{"x":0,"y":0,"w":100,"h":100},"focused":false}"#;
        let back: Pane = serde_json::from_str(older).unwrap();
        assert_eq!(back.url, None);
        assert_eq!(back.page, None);
        assert_eq!(back.driven_by, None);
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
