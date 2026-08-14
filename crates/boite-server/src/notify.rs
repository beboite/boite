use std::env;

use serde_json::json;

use boite_core::awareness::{Awareness, Phase};

// Outbound notification webhook. Boite's mobile story leans on the user's
// existing push infra (ntfy/Discord/Gotify) alongside the native Web Push stack
// in `push.rs`: the server POSTs on meaningful thread transitions (a turn
// finishing, a dialog going up, a process exiting).
//
// Everything it sends is built from one `Awareness` value, so the three formats
// differ in envelope and in nothing else. Before that each one composed its own
// sentence out of a status string, and none of the three carried a way back to
// the thread it was about.
#[derive(Clone, Copy)]
enum Format {
    Ntfy,
    Discord,
    Json,
}

#[derive(Clone)]
pub struct Notifier {
    client: reqwest::Client,
    url: Option<String>,
    format: Format,
    /// Where this workspace answers from, on the internet. `None` unless
    /// `BOITE_PUBLIC_URL` says so, and a link is then sent as the bare path.
    ///
    /// A server cannot work this out for itself: it is behind a reverse proxy
    /// on the deployment this feature is for, so the address it is bound to is
    /// not the address anybody reaches it at. Guessing one would produce a
    /// notification whose only button opens nothing.
    base: Option<String>,
}

/// Whether the webhook URL is one the server may POST to.
///
/// Softer than `push::acceptable_endpoint` on purpose, and for a reason worth
/// naming: a push endpoint is chosen by a *client*, so an unchecked one turns
/// the server into somebody else's outbound request. This one comes from the
/// environment of the process, which is the operator, and a self-hosted ntfy on
/// the LAN over plain http is the ordinary case. What is still refused is a
/// scheme that is not http, because a `file:` or a `data:` there is never a
/// webhook.
fn acceptable_webhook(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

impl Notifier {
    pub fn from_env() -> Notifier {
        let url = env::var("BOITE_WEBHOOK_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .filter(|s| {
                let ok = acceptable_webhook(s);
                if !ok {
                    tracing::warn!("BOITE_WEBHOOK_URL is not an http(s) URL; notifications are off");
                }
                ok
            });
        let format = match env::var("BOITE_WEBHOOK_FORMAT")
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "ntfy" => Format::Ntfy,
            "discord" => Format::Discord,
            _ => Format::Json,
        };
        let base = env::var("BOITE_PUBLIC_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .filter(|s| acceptable_webhook(s));
        Notifier {
            client: reqwest::Client::new(),
            url,
            format,
            base,
        }
    }

    pub fn enabled(&self) -> bool {
        self.url.is_some()
    }

    /// The deep link as something a notification client can open, or `None`.
    ///
    /// A relative path in an ntfy `Click` header or a Discord embed `url` is not
    /// a weaker link, it is a broken one: both clients hand it to a browser with
    /// no origin to resolve it against. Absent is the honest answer.
    fn absolute(&self, link: &str) -> Option<String> {
        self.base.as_ref().map(|base| format!("{base}{link}"))
    }

    /// Fire-and-forget: a failed webhook must never wedge the event loop.
    pub async fn send(&self, a: &Awareness) {
        let Some(url) = &self.url else {
            return;
        };
        let phase = phase_of(a);
        let click = self.absolute(&a.link);
        let req = match self.format {
            // ntfy: everything but the body is a header, and header values must
            // be visible ASCII. `Click` is what makes the notification a way in
            // rather than a note about something happening elsewhere.
            Format::Ntfy => {
                let mut req = self
                    .client
                    .post(url)
                    .header("Title", ascii_header(&a.headline))
                    .header("Tags", phase.tag())
                    .header("Priority", phase.priority())
                    .body(a.detail.clone());
                if let Some(click) = &click {
                    req = req.header("Click", ascii_header(click));
                }
                req
            }
            // Discord: an embed rather than a content line, so the title is a
            // link and the stripe carries the phase. `url` is dropped when it
            // cannot be absolute; Discord rejects the whole embed otherwise.
            Format::Discord => {
                let mut embed = json!({
                    "title": a.headline,
                    "description": a.detail,
                    "color": phase.color(),
                });
                if let Some(project) = &a.project {
                    embed["footer"] = json!({ "text": project });
                }
                if let Some(click) = &click {
                    embed["url"] = json!(click);
                }
                self.client.post(url).json(&json!({ "embeds": [embed] }))
            }
            // Generic JSON for Gotify and friends. `title`, `body` and `tag`
            // keep the names they have always had, so a consumer written against
            // the old shape still reads it; the awareness value is beside them.
            Format::Json => self.client.post(url).json(&json!({
                "title": a.headline,
                "body": a.detail,
                "tag": phase.tag(),
                "url": click,
                "awareness": a,
            })),
        };
        match req.send().await {
            Ok(r) if !r.status().is_success() => {
                tracing::warn!("webhook returned {}", r.status());
            }
            Err(e) => tracing::warn!("webhook send failed: {e}"),
            _ => {}
        }
    }
}

/// The phase back as a value.
///
/// `Awareness` carries it as a string because that is what crosses the wire to
/// a browser, and the tag, priority and colour hang off the enum. A phase this
/// build has never heard of still gets sent, wearing the neutral clothes: a
/// notification nobody can read is worth as little as one never sent.
fn phase_of(a: &Awareness) -> Phase {
    match a.phase {
        "starting" => Phase::Starting,
        "running" => Phase::Running,
        "waiting_for_approval" => Phase::WaitingForApproval,
        "waiting_for_input" => Phase::WaitingForInput,
        "completed" => Phase::Completed,
        "failed" => Phase::Failed,
        _ => Phase::Stale,
    }
}

// HTTP header values must be visible ASCII; claude titles carry unicode glyphs.
fn ascii_header(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| c.is_ascii() && !c.is_ascii_control())
        .collect();
    if cleaned.trim().is_empty() {
        "Boite".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use boite_core::awareness::{self, Facts};
    use boite_core::status::ThreadStatus;

    fn aware(status: ThreadStatus) -> Awareness {
        awareness::derive(&Facts {
            thread_id: "t-1",
            label: "✱ Claude #1",
            project_id: Some("p-1"),
            project: Some("boite"),
            status,
            exit_code: None,
            has_process: true,
            approval: None,
        })
    }

    fn with_base(base: Option<&str>) -> Notifier {
        Notifier {
            client: reqwest::Client::new(),
            url: Some("https://ntfy.example.com/boite".into()),
            format: Format::Ntfy,
            base: base.map(|b| b.trim_end_matches('/').to_string()),
        }
    }

    #[test]
    fn a_link_is_absolute_or_absent() {
        let a = aware(ThreadStatus::Waiting);
        assert_eq!(
            with_base(Some("https://boite.example.com/")).absolute(&a.link),
            Some("https://boite.example.com/?thread=t-1&project=p-1".into())
        );
        assert_eq!(with_base(None).absolute(&a.link), None);
    }

    /// Header values reach reqwest as `HeaderValue`, which refuses anything that
    /// is not visible ASCII. Every agent puts a spinner glyph in its title, so
    /// the headline is the field most likely to carry one.
    #[test]
    fn a_headline_with_a_spinner_in_it_survives_as_a_header() {
        let a = aware(ThreadStatus::Running);
        assert!(a.headline.contains('✱'), "the fixture has a glyph in it");
        let header = ascii_header(&a.headline);
        assert!(header.is_ascii());
        assert_eq!(header, " Claude #1 is working");
        assert_eq!(ascii_header("✱✻✦"), "Boite");
    }

    #[test]
    fn every_phase_has_a_tag_and_only_the_blocking_ones_are_urgent() {
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
            let a = aware(status);
            let phase = phase_of(&a);
            assert_eq!(phase.as_str(), a.phase, "{status:?}");
            assert!(!phase.tag().is_empty(), "{status:?}");
        }
        assert_eq!(phase_of(&aware(ThreadStatus::Waiting)).priority(), "high");
        assert_eq!(phase_of(&aware(ThreadStatus::Ready)).priority(), "default");
    }

    #[test]
    fn a_webhook_url_that_is_not_a_url_is_refused() {
        assert!(acceptable_webhook("https://ntfy.sh/boite"));
        // A self-hosted ntfy on the LAN is the ordinary deployment.
        assert!(acceptable_webhook("http://192.168.1.10:8080/boite"));
        assert!(!acceptable_webhook("file:///etc/passwd"));
        assert!(!acceptable_webhook("ntfy.sh/boite"));
        assert!(!acceptable_webhook(""));
    }
}
