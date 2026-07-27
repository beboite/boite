//! The server-side twin of the desktop `agent_api`: the door an agent running
//! in a remote workspace uses to reach its own todo list.
//!
//! It gets its own listener on loopback rather than routes on the main router,
//! and its own token. The main server may be bound to a routable interface —
//! that is the whole point of a remote workspace — and nothing here belongs on
//! a network. The client token and this one are also different secrets: a
//! device that can drive the workspace is not the same principal as an agent
//! that may append to a checklist.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;

use crate::events::AppEvent;
use crate::store::Store;

#[derive(Clone)]
pub struct AgentApi {
    pub url: String,
    pub token: String,
}

struct Inner {
    store: Arc<Store>,
    events: broadcast::Sender<AppEvent>,
    token: String,
}

#[derive(Deserialize)]
struct AddIn {
    text: String,
}

#[derive(Deserialize)]
struct ClaimIn {
    id: String,
    note: Option<String>,
    /// The commit the work landed in, if it landed in one. Stored as given: the
    /// client resolves it against this machine's repository before showing it,
    /// so a sha nothing backs reads as unknown rather than as done.
    commit: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Token proves the caller came from us; the thread decides what it may see.
/// A leaked token with no thread id reaches nothing.
fn authorize(inner: &Inner, headers: &HeaderMap) -> Result<String, StatusCode> {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if bearer.len() != inner.token.len() || bearer != inner.token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let thread_id = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if thread_id.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    inner
        .store
        .project_of_thread(thread_id)
        .map_err(|_| StatusCode::NOT_FOUND)
}

async fn list(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let todos = inner
        .store
        .todos_for_project(&project_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({ "todos": todos })))
}

async fn add(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<AddIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    let text = body.text.trim();
    if text.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = inner
        .store
        .add_todo(&project_id, text, now_ms())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = inner.events.send(AppEvent::TodosChanged);
    Ok(Json(json!({ "id": id })))
}

async fn claim(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Json(body): Json<ClaimIn>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let project_id = authorize(&inner, &headers)?;
    // The thread names the agent: this server spawned it, so it knows what it
    // is. Nothing the caller sends decides this.
    let agent = headers
        .get("x-boite-thread")
        .and_then(|v| v.to_str().ok())
        .and_then(|id| inner.store.agent_of_thread(id));
    let changed = inner
        .store
        .claim_todo(
            &body.id,
            &project_id,
            body.note.as_deref(),
            body.commit.as_deref(),
            agent.as_deref(),
            now_ms(),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !changed {
        // Not this project's row, or no longer open. Both are refusals, and the
        // agent does not get to learn which.
        return Err(StatusCode::CONFLICT);
    }
    let _ = inner.events.send(AppEvent::TodosChanged);
    Ok(Json(json!({ "ok": true })))
}

/// Binds an ephemeral loopback port and returns what the PTY spawn path stamps
/// into each child. Returns None if the listener cannot start: the workspace
/// still works, agents just have no todo access.
pub async fn start(store: Arc<Store>, events: broadcast::Sender<AppEvent>) -> Option<AgentApi> {
    let token = format!("{:032x}", rand::random::<u128>());
    let inner = Arc::new(Inner {
        store,
        events,
        token: token.clone(),
    });

    let router = Router::new()
        .route("/v1/todos", get(list).post(add))
        .route("/v1/todos/claim", post(claim))
        .with_state(inner);

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!("agent api disabled, bind failed: {e}");
            return None;
        }
    };
    let port = listener.ok_port()?;

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::warn!("agent api ended: {e}");
        }
    });

    Some(AgentApi {
        url: format!("http://127.0.0.1:{port}"),
        token,
    })
}

/// Small helper so the bind path stays a single expression chain.
trait LocalPort {
    fn ok_port(&self) -> Option<u16>;
}

impl LocalPort for tokio::net::TcpListener {
    fn ok_port(&self) -> Option<u16> {
        self.local_addr().ok().map(|a| a.port())
    }
}
