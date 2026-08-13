use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::{SplitStream, StreamExt};
use futures_util::SinkExt;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::auth::Session;
use crate::authz::Authorized;
use crate::events::AppEvent;
use crate::protocol::{self, Event, Request, Response};
use crate::rpc;
use crate::state::AppState;

const WRITER_CAP: usize = 1024;
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

enum WsOut {
    Text(String),
    Binary(Vec<u8>),
    /// Hang up, from this side.
    ///
    /// The one thing a task holding only the writer channel cannot otherwise
    /// do. A revoked device has to stop *now*, and a connection that merely
    /// refuses every call is one the user watches sit there looking connected.
    Close,
}

// Decrements the live-connection counter however handle_socket returns.
struct ConnGuard<'a>(&'a std::sync::atomic::AtomicUsize);
impl Drop for ConnGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

pub async fn handle_socket(socket: WebSocket, state: Arc<AppState>, addr: SocketAddr) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<WsOut>(WRITER_CAP);

    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let msg = match out {
                WsOut::Text(s) => Message::Text(s.into()),
                WsOut::Binary(b) => Message::Binary(b.into()),
                WsOut::Close => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let n = state.conns.fetch_add(1, Ordering::Relaxed) + 1;
    let _conn = ConnGuard(&state.conns);
    if n > state.max_connections {
        let _ = tx
            .send(WsOut::Text(json_str(&Response::err(0, "server busy".into()))))
            .await;
        writer.abort();
        return;
    }

    let Some(session) = authenticate(&mut stream, &state, addr, &tx).await else {
        writer.abort();
        return;
    };
    // Past this point the client receives control events, so it is one of the
    // devices that can carry out an agent request. The agent endpoint refuses
    // to promise anything when this reaches zero.
    state.devices.fetch_add(1, Ordering::Relaxed);
    let _device = ConnGuard(&state.devices);

    // Set by the control task the moment this pairing is revoked, and read by
    // the binary frame path. An RPC asks the database instead (see
    // `authz::Authorized::check`), which is the answer that does not depend on
    // a broadcast having been delivered; this is what reaches a socket that is
    // only carrying keystrokes.
    let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Fan control-plane events out to this client.
    let mut events_rx = state.events.subscribe();
    let tx_ctrl = tx.clone();
    let my_pairing = session.pairing_id().to_string();
    let revoked_ctrl = revoked.clone();
    let control = tokio::spawn(async move {
        loop {
            match events_rx.recv().await {
                Ok(AppEvent::PairingRevoked { pairing_id }) if pairing_id == my_pairing => {
                    // This connection is over. Said once so the client can put
                    // the login gate up rather than reconnect into a refusal,
                    // then hung up: a socket that merely refuses every call is
                    // one the user watches sit there looking connected.
                    revoked_ctrl.store(true, Ordering::Relaxed);
                    let _ = tx_ctrl
                        .send(WsOut::Text(json_str(&Response::err(
                            0,
                            crate::authz::REVOKED.to_string(),
                        ))))
                        .await;
                    let _ = tx_ctrl.send(WsOut::Close).await;
                    break;
                }
                Ok(ev) => {
                    if let Ok(s) = serde_json::to_string(&ev.to_event()) {
                        if tx_ctrl.send(WsOut::Text(s)).await.is_err() {
                            break;
                        }
                    }
                }
                // Dropped control events leave the client with stale thread
                // state; tell it to refetch rather than silently diverge. A
                // revocation can be among what was dropped, which is why it is
                // not the only thing enforcing one.
                Err(RecvError::Lagged(_)) => {
                    if let Ok(s) = serde_json::to_string(&Event::new("resync", json!({}))) {
                        if tx_ctrl.send(WsOut::Text(s)).await.is_err() {
                            break;
                        }
                    }
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    let mut attached: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                let req: Request = match serde_json::from_str(&text) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let id = req.id.unwrap_or(0);
                // One gate, before the arms rather than inside them. The two
                // methods this file serves itself go through it too: attaching
                // to a PTY is the single thing a read-only device must not
                // reach, and a check written per arm is a check the next arm
                // forgets. `Authorized` cannot be built any other way.
                let request =
                    match Authorized::check(&state.store, &session, &req.method, req.params) {
                        Ok(request) => request,
                        Err(e) => {
                            let _ = tx.send(WsOut::Text(json_str(&Response::err(id, e)))).await;
                            continue;
                        }
                    };
                match request.method() {
                    // The handshake happened, and it is not repeatable. A
                    // second one on a live socket would be a way to change who
                    // a connection belongs to after it was let in.
                    "auth" => {
                        let _ = tx
                            .send(WsOut::Text(json_str(&Response::err(
                                id,
                                "this socket is already authenticated".into(),
                            ))))
                            .await;
                    }
                    "thread.attach" => {
                        handle_attach(&state, request.params(), id, &tx, &mut attached).await;
                    }
                    "thread.detach" => {
                        if let Some(tid) = request.params().get("threadId").and_then(|v| v.as_str())
                        {
                            if let Some(h) = attached.remove(tid) {
                                h.abort();
                            }
                        }
                        let _ = tx
                            .send(WsOut::Text(json_str(&Response::ok(id, json!({ "ok": true })))))
                            .await;
                    }
                    _ => {
                        let resp = match rpc::dispatch(&state, request).await {
                            Ok(v) => Response::ok(id, v),
                            Err(e) => Response::err(id, e),
                        };
                        let _ = tx.send(WsOut::Text(json_str(&resp))).await;
                    }
                }
            }
            Message::Binary(bytes) => {
                // A revoked device stops typing into a terminal at once, which
                // is the case a check at the next RPC would miss entirely: a
                // socket carrying only keystrokes makes no RPCs.
                if revoked.load(Ordering::Relaxed) {
                    break;
                }
                if let Some((op, tid, payload)) = protocol::parse_frame(&bytes) {
                    // Only accept input for threads THIS socket attached to:
                    // a known UUID alone must not let one client inject
                    // keystrokes into another's PTY. Attaching is gated on the
                    // terminal scope, so this set is empty for a device that
                    // does not hold one.
                    if op == protocol::FRAME_INPUT && attached.contains_key(&tid.to_string()) {
                        let _ = state.registry.write(&tid.to_string(), payload);
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    for (_, h) in attached {
        h.abort();
    }
    control.abort();
    writer.abort();
}

async fn handle_attach(
    state: &Arc<AppState>,
    params: &serde_json::Value,
    id: u64,
    tx: &mpsc::Sender<WsOut>,
    attached: &mut HashMap<String, tokio::task::JoinHandle<()>>,
) {
    let thread_id = match params.get("threadId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            let _ = tx
                .send(WsOut::Text(json_str(&Response::err(id, "missing threadId".into()))))
                .await;
            return;
        }
    };
    let uuid = match Uuid::parse_str(&thread_id) {
        Ok(u) => u,
        Err(_) => {
            let _ = tx
                .send(WsOut::Text(json_str(&Response::err(
                    id,
                    "threadId must be a uuid".into(),
                ))))
                .await;
            return;
        }
    };
    let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
    // Client's last known byte offset (delta replay) and whether it can inflate
    // a gzip replay frame (DecompressionStream support).
    let since = params.get("since").and_then(|v| v.as_u64());
    let gzip = params.get("gzip").and_then(|v| v.as_bool()).unwrap_or(false);

    if let Some(h) = attached.remove(&thread_id) {
        h.abort();
    }

    match state.registry.attach(&thread_id, cols, rows, since) {
        Some(snap) => {
            // Replay marker carries the PTY size (so the client sizes its
            // terminal first), the end offset (tracked for the next reattach),
            // and reset (full ring => clear first; delta => append).
            let marker = Event::new(
                "replay",
                json!({
                    "threadId": thread_id,
                    "size": { "cols": snap.cols, "rows": snap.rows },
                    "bytes": snap.replay.len(),
                    "offset": snap.offset,
                    "reset": snap.reset,
                    "gzip": gzip && !snap.replay.is_empty(),
                }),
            );
            let _ = tx.send(WsOut::Text(json_str(&marker))).await;
            let _ = tx.send(replay_frame(&uuid, &snap.replay, gzip)).await;

            let txf = tx.clone();
            let mut rxf = snap.rx;
            let registry = state.registry.clone();
            let replay_id = thread_id.clone();
            let h = tokio::spawn(async move {
                loop {
                    match rxf.recv().await {
                        Ok(bytes) => {
                            if txf
                                .send(WsOut::Binary(protocol::encode_output(&uuid, &bytes)))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        // Receiver fell behind the broadcast cap. Resend the
                        // whole scrollback (reset) so xterm resyncs instead of
                        // rendering a truncated escape stream.
                        Err(RecvError::Lagged(_)) => {
                            if let Some((buf, off)) = registry.replay(&replay_id) {
                                let marker = Event::new(
                                    "replay",
                                    json!({
                                        "threadId": replay_id,
                                        "bytes": buf.len(),
                                        "offset": off,
                                        "reset": true,
                                        "gzip": gzip && !buf.is_empty(),
                                    }),
                                );
                                if txf.send(WsOut::Text(json_str(&marker))).await.is_err() {
                                    break;
                                }
                                if txf.send(replay_frame(&uuid, &buf, gzip)).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            });
            attached.insert(thread_id.clone(), h);

            // The pty id is the client's stable key for this attachment (stored
            // as thread.ptyId, used for write/resize/kill) and matches the live
            // overlay in thread.list.
            let pty_id = state.registry.live(&thread_id).map(|l| l.pty_id());
            let _ = tx
                .send(WsOut::Text(json_str(&Response::ok(
                    id,
                    json!({
                        "ok": true,
                        "ptyId": pty_id,
                        "size": { "cols": snap.cols, "rows": snap.rows },
                    }),
                ))))
                .await;
        }
        None => {
            let _ = tx
                .send(WsOut::Text(json_str(&Response::err(id, "thread not live".into()))))
                .await;
        }
    }
}

/// What the first frame has to carry, and what it may not.
///
/// **A ticket, never the device's own credential.** The ticket was bought over
/// authenticated HTTP seconds ago (`http::ticket`), is good for one connection
/// and expires in five minutes, so what travels through this frame — and
/// through whatever proxy is in front of it — is worth nothing by the time
/// anybody could replay it. A long-lived credential presented here is refused
/// like any other wrong secret, on purpose: accepting both would leave the old
/// shape working under a new name.
async fn authenticate(
    stream: &mut SplitStream<WebSocket>,
    state: &Arc<AppState>,
    addr: SocketAddr,
    tx: &mpsc::Sender<WsOut>,
) -> Option<Session> {
    let ip = addr.ip();
    if state.auth.is_locked(ip) {
        return None;
    }
    let first = tokio::time::timeout(AUTH_TIMEOUT, stream.next()).await;
    // A frame that is not a well-formed auth request still has to reach
    // auth.spend_ticket: routing malformed or wrong-method first frames around
    // it left the per-IP lockout untrippable by exactly the traffic a prober
    // sends. Timeouts and closes are NOT counted — a client that hangs up
    // before authenticating (tab closed, network blip) is not an attempt, and
    // counting it would lock out a legitimate device after five reconnects.
    let attempt: Option<(u64, String)> = match &first {
        Ok(Some(Ok(Message::Text(text)))) => Some(
            serde_json::from_str::<Request>(text.as_str())
                .ok()
                .filter(|req| req.method == "auth")
                .map(|req| {
                    (
                        req.id.unwrap_or(0),
                        req.params
                            .get("ticket")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    )
                })
                // A text frame that is not a usable auth request is still an
                // attempt: that is what a prober sends. So is one carrying
                // `token` instead of `ticket`, which is what a client built
                // before this sends — it reads the empty string and is refused,
                // rather than being quietly accepted on the old path.
                .unwrap_or((0, String::new())),
        ),
        Ok(Some(Ok(Message::Binary(_)))) => Some((0, String::new())),
        // Close/Ping/Pong and the timeout are NOT attempts. A client that hangs
        // up before authenticating (tab closed, network blip, connectivity
        // probe) sends a Close frame, and counting it locked the IP out after
        // five reconnects — a PWA banning its own device.
        _ => None,
    };

    if let Some((id, ticket)) = attempt {
        if let Some(session) = state.auth.spend_ticket(ip, &state.store, &ticket) {
            let _ = tx
                .send(WsOut::Text(json_str(&Response::ok(
                    id,
                    json!({
                        "ok": true,
                        "scopes": session.scopes(),
                        "label": session.label(),
                    }),
                ))))
                .await;
            return Some(session);
        }
    }
    let _ = tx
        .send(WsOut::Text(json_str(&Response::err(0, "auth failed".into()))))
        .await;
    None
}

fn json_str<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

// Replay frames are bursty and one-shot (scrollback up to the ring size), so
// gzip them when the client can inflate. Live frames stay raw: per-chunk
// compression adds latency and barely helps on tiny writes.
fn replay_frame(thread_id: &Uuid, bytes: &[u8], gzip: bool) -> WsOut {
    if gzip && !bytes.is_empty() {
        WsOut::Binary(protocol::encode_frame(
            protocol::FRAME_OUTPUT_GZIP,
            thread_id,
            &gzip_bytes(bytes),
        ))
    } else {
        WsOut::Binary(protocol::encode_output(thread_id, bytes))
    }
}

fn gzip_bytes(data: &[u8]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    if enc.write_all(data).is_err() {
        return data.to_vec();
    }
    enc.finish().unwrap_or_else(|_| data.to_vec())
}
