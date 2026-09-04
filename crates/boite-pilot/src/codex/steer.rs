use super::{CodexSession, CONTROL_TIMEOUT};
use crate::driver::{PilotError, TurnInput};
use serde_json::json;

impl CodexSession {
    pub(super) async fn steer_if_active(
        &self,
        input: &TurnInput,
    ) -> Result<Option<String>, PilotError> {
        let target = {
            let state = self.shared.state.lock();
            if state.exited {
                return Err(PilotError::SessionGone("Codex App Server exited".into()));
            }
            let Some(turn) = &state.turn else {
                return Ok(None);
            };
            if state.interrupting || !state.open_requests.is_empty() {
                return Err(PilotError::Protocol(
                    "Codex is interrupting or waiting for an answer".into(),
                ));
            }
            if input.selection.is_some() {
                return Err(PilotError::Protocol(
                    "Codex steering cannot change turn settings".into(),
                ));
            }
            match (&state.native_thread_id, &state.provider_turn) {
                (Some(thread), Some(provider_turn)) => {
                    (turn.clone(), thread.clone(), provider_turn.clone())
                }
                _ => {
                    return Err(PilotError::Protocol(
                        "Codex is still starting the turn; retry after it starts".into(),
                    ))
                }
            }
        };
        self.request(
            "turn/steer",
            json!({
                "threadId": target.1,
                "expectedTurnId": target.2,
                "input": [{ "type": "text", "text": input.text }],
            }),
            CONTROL_TIMEOUT,
        )
        .await?;
        // A failed steer must leave the active turn and its usage untouched.
        Ok(Some(target.0))
    }
}
