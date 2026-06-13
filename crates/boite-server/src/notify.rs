use std::env;

use serde_json::json;

// Outbound notification webhook. Boite's mobile story leans on the user's
// existing push infra (ntfy/Discord/Gotify) rather than a bespoke Web Push
// stack: the server POSTs on meaningful thread transitions (a turn finishing,
// a process exiting). Native VAPID Web Push is a documented future enhancement
// (it needs openssl + a real device to verify); the webhook path is testable
// and covers app-closed delivery via the ntfy app.
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
}

impl Notifier {
    pub fn from_env() -> Notifier {
        let url = env::var("BOITE_WEBHOOK_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let format = match env::var("BOITE_WEBHOOK_FORMAT")
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "ntfy" => Format::Ntfy,
            "discord" => Format::Discord,
            _ => Format::Json,
        };
        Notifier {
            client: reqwest::Client::new(),
            url,
            format,
        }
    }

    pub fn enabled(&self) -> bool {
        self.url.is_some()
    }

    /// Fire-and-forget: a failed webhook must never wedge the event loop.
    pub async fn send(&self, title: &str, body: &str, tag: &str) {
        let Some(url) = &self.url else {
            return;
        };
        let req = match self.format {
            // ntfy: title + tags as headers (ASCII-only), body as plain text.
            Format::Ntfy => self
                .client
                .post(url)
                .header("Title", ascii_header(title))
                .header("Tags", tag)
                .body(body.to_owned()),
            // Discord: single content field, markdown bold title.
            Format::Discord => self
                .client
                .post(url)
                .json(&json!({ "content": format!("**{title}**\n{body}") })),
            // Generic JSON for Gotify and friends.
            Format::Json => self
                .client
                .post(url)
                .json(&json!({ "title": title, "body": body, "tag": tag })),
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
