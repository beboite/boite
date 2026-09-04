//! The App Server catalog is authoritative; the bundled list is an offline fallback.
use super::CodexSession;
use crate::driver::PilotError;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};

impl CodexSession {
    pub(super) async fn available_models(&self) -> Result<Vec<String>, PilotError> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut cursor: Option<String> = None;
        let mut cursors = HashSet::new();
        let mut models = Vec::new();
        for _ in 0..20 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(PilotError::Timeout);
            }
            let page = self
                .request(
                    "model/list",
                    json!({
                        "limit": 100, "includeHidden": false, "cursor": cursor,
                    }),
                    remaining,
                )
                .await?;
            let entries = page["data"].as_array().ok_or_else(|| {
                PilotError::Protocol("Codex model/list returned no data array".into())
            })?;
            for entry in entries {
                if entry["hidden"].as_bool() == Some(true) {
                    continue;
                }
                if let Some(model) = entry["model"].as_str().or_else(|| entry["id"].as_str()) {
                    if !model.trim().is_empty() && !models.iter().any(|known| known == model) {
                        models.push(model.to_string());
                    }
                }
            }
            match &page["nextCursor"] {
                Value::Null => return Ok(models),
                Value::String(next) if !next.is_empty() && cursors.insert(next.clone()) => {
                    cursor = Some(next.clone());
                }
                _ => {
                    return Err(PilotError::Protocol(
                        "Codex model/list returned an invalid or repeated cursor".into(),
                    ))
                }
            }
        }
        Err(PilotError::Protocol(
            "Codex model/list exceeded 20 pages".into(),
        ))
    }
}
