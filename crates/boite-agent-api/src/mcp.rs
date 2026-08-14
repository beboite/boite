//! MCP over HTTP, revision 2026-07-28, on the same door as everything else.
//!
//! One POST endpoint, `/mcp`, exactly as the Streamable HTTP transport asks:
//! each request arrives on its own, carries its protocol version in `_meta`,
//! and is answered without any session existing before or after it. The
//! protocol engine is `boite_mcp::rpc`, shared with the stdio shim, so the two
//! doors cannot drift; what this module owns is only what HTTP adds — the
//! mirrored headers the transport requires, the `Origin` refusal, and the
//! mapping from protocol errors to status codes.
//!
//! A tool call is dispatched into this crate's own `/v1` handlers in-process
//! (`routes::open`), with the caller the `/mcp` request already proved. That
//! is the same trick the stdio shim performs over loopback, minus the loop:
//! one behaviour, reached through either door.
//!
//! The endpoint answers on the hosts' loopback listeners today. Exposing it on
//! a public address is deliberately left until pairing-scoped credentials
//! exist: a workspace token that can reach every project is the wrong thing to
//! put on the open internet.

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{json, Value};

use boite_mcp::backend::{refusal_for, Backend, IdCache};
use boite_mcp::rpc;

use crate::auth::Caller;
use crate::Shared;

/// A response no `/v1` handler should ever exceed; transcripts are capped
/// below this by their own route.
const MAX_INNER_BODY: usize = 4 * 1024 * 1024;

/// One MCP message in, one answer out, statelessly.
pub(crate) async fn endpoint(
    State(workspace): State<Shared>,
    Extension(caller): Extension<Caller>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // The transport's DNS-rebinding rule. No browser has any business here:
    // a page that can reach this endpoint is a page holding a credential, and
    // refusing the Origin header outright is the whole of the defence.
    if headers.contains_key(axum::http::header::ORIGIN) {
        return (StatusCode::FORBIDDEN, protocol_error(Value::Null, -32600, "browser origins are not served here")).into_response();
    }

    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        return (
            StatusCode::BAD_REQUEST,
            protocol_error(Value::Null, -32700, "the body is not JSON"),
        )
            .into_response();
    };

    // A notification expects nothing back, and 202 is how this transport says
    // "taken" without inventing a body to say it in.
    if msg.get("id").is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = msg["id"].clone();

    // The mirrored headers, checked before the engine runs. Only a modern
    // request owes them: the header requirements arrived with the revision
    // that put the version into `_meta`, and a legacy client has never heard
    // of either.
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    if rpc::modern_version(&params).is_some() {
        if let Err(reason) = mirrored_headers_match(&headers, &msg, &params) {
            return (
                StatusCode::BAD_REQUEST,
                protocol_error(id, rpc::HEADER_MISMATCH, &reason),
            )
                .into_response();
        }
    }

    // The engine and the tool dispatch are synchronous by design (the stdio
    // shim is a loop over lines), so the whole answer is computed off the
    // runtime, and the in-process `/v1` calls hop back onto it one by one.
    let handle = tokio::runtime::Handle::current();
    let answered = tokio::task::spawn_blocking(move || {
        let door = InProcess {
            router: crate::routes::open(workspace),
            caller,
            handle,
            ids: IdCache::new(),
        };
        let call = |name: &str, args: &Value| boite_mcp::call_tool(&door, name, args);
        // `/v1/browser/screenshot` is on this router like every other tool
        // route, so the door that answers in content blocks is wired here too:
        // an agent reaching the workspace over HTTP gets the same image the
        // stdio shim would have handed it.
        let blocks = |name: &str, args: &Value| boite_mcp::call_blocks(&door, name, args);
        let service = rpc::Service {
            call: &call,
            blocks: Some(&blocks),
            tools: boite_mcp::tools(),
            instructions: boite_mcp::INSTRUCTIONS,
        };
        rpc::answer(&service, &msg)
    })
    .await;

    let Ok(Some(reply)) = answered else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            protocol_error(id, -32603, "the call could not be dispatched"),
        )
            .into_response();
    };

    // Protocol errors ride the status the transport names for them; everything
    // else, tool failures included, is a 200 the client reads as a result.
    let status = match reply.get("error").and_then(|e| e.get("code")).and_then(|c| c.as_i64()) {
        Some(rpc::UNSUPPORTED_PROTOCOL_VERSION) | Some(rpc::HEADER_MISMATCH) => {
            StatusCode::BAD_REQUEST
        }
        Some(rpc::METHOD_NOT_FOUND) => StatusCode::NOT_FOUND,
        _ => StatusCode::OK,
    };
    (status, Json(reply)).into_response()
}

fn protocol_error(id: Value, code: i64, message: &str) -> Json<Value> {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }))
}

/// The transport mirrors body fields into headers so intermediaries can route
/// without parsing; a server that reads the body must then check the two say
/// the same thing, or a gateway and this process would act on different calls.
fn mirrored_headers_match(headers: &HeaderMap, msg: &Value, params: &Value) -> Result<(), String> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };

    let version = rpc::modern_version(params).unwrap_or_default();
    match header("mcp-protocol-version") {
        None => return Err("the MCP-Protocol-Version header is required".into()),
        Some(h) if h != version => {
            return Err(format!(
                "MCP-Protocol-Version says {h} and the body says {version}"
            ))
        }
        Some(_) => {}
    }

    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    match header("mcp-method") {
        None => return Err("the Mcp-Method header is required".into()),
        Some(h) if h != method => {
            return Err(format!("Mcp-Method says {h} and the body says {method}"))
        }
        Some(_) => {}
    }

    if method == "tools/call" {
        let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
        match header("mcp-name").as_deref().map(decode_sentinel) {
            None => return Err("the Mcp-Name header is required on tools/call".into()),
            Some(h) if h != name => {
                return Err(format!("Mcp-Name says {h} and the body says {name}"))
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// Undoes the transport's `=?base64?...?=` sentinel, used when a mirrored
/// value cannot travel as plain ASCII. Ours always can, but the client
/// decides, and a compliant one may encode anything it likes.
fn decode_sentinel(value: &str) -> String {
    let Some(inner) = value.strip_prefix("=?base64?").and_then(|v| v.strip_suffix("?=")) else {
        return value.to_string();
    };
    match base64_decode(inner) {
        Some(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        None => value.to_string(),
    }
}

/// Standard alphabet, `=` padding, nothing else: exactly what the sentinel
/// carries. Twenty lines beat a dependency this crate takes nowhere else.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(b: u8) -> Option<u32> {
        match b {
            b'A'..=b'Z' => Some((b - b'A') as u32),
            b'a'..=b'z' => Some((b - b'a' + 26) as u32),
            b'0'..=b'9' => Some((b - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut acc = 0u32;
        for &b in chunk {
            acc = (acc << 6) | val(b)?;
        }
        acc <<= 6 * (4 - chunk.len()) as u32;
        let bytes = acc.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

/// The in-process door to this crate's own `/v1` handlers.
///
/// What `boite_mcp::host::Host` is over loopback, this is over a function
/// call: the same routes, the same refusals, no socket and no signature. The
/// caller is stamped into each synthesized request's extensions, which is
/// exactly what the identity layer would have done had the request arrived
/// from outside.
struct InProcess {
    router: axum::Router,
    caller: Caller,
    handle: tokio::runtime::Handle,
    ids: IdCache,
}

impl Backend for InProcess {
    fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .body(match &body {
                Some(v) => Body::from(v.to_string()),
                None => Body::empty(),
            })
            .map_err(|e| format!("bad internal request: {e}"))?;
        request.extensions_mut().insert(self.caller.clone());

        let router = self.router.clone();
        let (status, bytes) = self
            .handle
            .block_on(async move {
                use tower::ServiceExt;
                let response = router
                    .oneshot(request)
                    .await
                    .map_err(|_| "internal dispatch failed".to_string())?;
                let status = response.status().as_u16();
                let bytes = axum::body::to_bytes(response.into_body(), MAX_INNER_BODY)
                    .await
                    .map_err(|e| format!("could not read the answer: {e}"))?;
                Ok::<_, String>((status, bytes))
            })?;

        if !(200..300).contains(&status) {
            return Err(refusal_for(path, status));
        }
        serde_json::from_slice(&bytes).map_err(|e| format!("bad response: {e}"))
    }

    fn remember(&self, short: &str, full: &str) {
        self.ids.remember(short, full);
    }

    fn full_id(&self, given: &str) -> String {
        self.ids.resolve(self, given)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;

    use axum::body::to_bytes;
    use boite_core::capability::Grant;

    use crate::testing::Fake;

    #[test]
    fn the_base64_sentinel_decodes_and_plain_values_pass_through() {
        assert_eq!(decode_sentinel("todo_list"), "todo_list");
        // "Hello, 世界" from the transport page's own table.
        assert_eq!(decode_sentinel("=?base64?SGVsbG8sIOS4lueVjA==?="), "Hello, 世界");
        // A broken payload is left as it came, and the comparison then fails
        // loudly instead of this half inventing a value.
        assert_eq!(decode_sentinel("=?base64?%%%?="), "=?base64?%%%?=");
    }

    fn caller() -> Caller {
        Caller {
            project_id: "p1".into(),
            thread_id: Some("t1".into()),
            grant: Grant::Owner,
            agent: None,
        }
    }

    async fn hit(workspace: Shared, headers: &[(&str, &str)], body: Value) -> (u16, Value) {
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        let response = endpoint(
            State(workspace),
            Extension(caller()),
            map,
            Bytes::from(body.to_string()),
        )
        .await;
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), MAX_INNER_BODY).await.unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    fn meta() -> Value {
        json!({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" })
    }

    /// The whole promise of the route in one pass: a modern client probes,
    /// lists and calls without any handshake existing, a legacy one still gets
    /// its handshake, and the tool call really reaches the same `/v1` handler
    /// the stdio shim would have.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_mcp_door_serves_both_eras_on_one_endpoint() {
        let workspace: Shared = Arc::new(Fake::new("mcp-door"));

        let (status, out) = hit(
            workspace.clone(),
            &[("mcp-protocol-version", "2026-07-28"), ("mcp-method", "server/discover")],
            json!({ "jsonrpc": "2.0", "id": 1, "method": "server/discover",
                    "params": { "_meta": meta() } }),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(out["result"]["supportedVersions"], json!(["2026-07-28"]));
        assert_eq!(out["result"]["resultType"], "complete");

        let (status, out) = hit(
            workspace.clone(),
            &[
                ("mcp-protocol-version", "2026-07-28"),
                ("mcp-method", "tools/call"),
                ("mcp-name", "todo_list"),
            ],
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": { "name": "todo_list", "arguments": {}, "_meta": meta() } }),
        )
        .await;
        assert_eq!(status, 200);
        let text = out["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("todos(0)"), "{text}");

        let (status, out) = hit(
            workspace.clone(),
            &[],
            json!({ "jsonrpc": "2.0", "id": 3, "method": "initialize",
                    "params": { "protocolVersion": "2025-06-18" } }),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(out["result"]["protocolVersion"], "2025-06-18");
    }

    /// The transport's own rejections: a mirrored header that disagrees with
    /// the body, a version this does not speak, and a browser origin.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_mcp_door_refuses_what_the_transport_says_it_must() {
        let workspace: Shared = Arc::new(Fake::new("mcp-refusals"));

        let (status, out) = hit(
            workspace.clone(),
            &[("mcp-protocol-version", "2026-07-28"), ("mcp-method", "tools/list")],
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": "todo_list", "_meta": meta() } }),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(out["error"]["code"], rpc::HEADER_MISMATCH);

        let (status, out) = hit(
            workspace.clone(),
            &[("mcp-protocol-version", "2099-01-01"), ("mcp-method", "tools/list")],
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list",
                    "params": { "_meta": { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } }),
        )
        .await;
        assert_eq!(status, 400);
        assert_eq!(out["error"]["code"], rpc::UNSUPPORTED_PROTOCOL_VERSION);
        assert_eq!(out["error"]["data"]["supported"], json!(["2026-07-28"]));

        let (status, _) = hit(
            workspace.clone(),
            &[("origin", "https://evil.example")],
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {} }),
        )
        .await;
        assert_eq!(status, 403);

        // A notification is taken and answered with nothing, which on this
        // transport is a 202.
        let (status, out) = hit(
            workspace,
            &[],
            json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": {} }),
        )
        .await;
        assert_eq!(status, 202);
        assert_eq!(out, Value::Null);
    }
}
