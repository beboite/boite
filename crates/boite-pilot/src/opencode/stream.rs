use super::{sse, transport::Api, Shared};
use crate::driver::PilotError;
use crate::event::{ExitReason, PilotEvent};
use crate::proc::Child;
use std::sync::{Arc, Weak};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

pub(super) async fn event_loop(
    api: Api,
    shared: Arc<Shared>,
    connected: oneshot::Sender<()>,
    child: Option<Weak<AsyncMutex<Child>>>,
) {
    let mut connected = Some(connected);
    let result = async {
        let mut response = api.event_response().await?;
        let mut decoder = sse::Decoder::default();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| PilotError::Protocol(error.to_string()))?
        {
            for event in decoder.push(&chunk)? {
                if event["type"].as_str() == Some("server.connected") {
                    if let Some(sender) = connected.take() {
                        let _ = sender.send(());
                    }
                }
                super::reduce::handle_event(&shared, &event);
            }
        }
        Ok::<(), PilotError>(())
    }
    .await;
    if !shared.state.lock().stopping {
        match result {
            Err(error) => {
                shared.sink.emit(PilotEvent::Error {
                    message: format!("OpenCode event stream ended: {error}"),
                    turn_id: shared.state.lock().turn.clone(),
                });
            }
            Ok(()) => {
                shared.sink.emit(PilotEvent::Error {
                    message: "OpenCode event stream ended unexpectedly".into(),
                    turn_id: shared.state.lock().turn.clone(),
                });
            }
        }
        shared.exit(ExitReason::Crashed { code: None });
        if let Some(child) = child.and_then(|child| child.upgrade()) {
            child.lock().await.stop().await;
        }
    }
}
