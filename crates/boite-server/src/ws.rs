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

use crate::protocol::{self, Event, Request, Response};
use crate::rpc;
use crate::state::AppState;

const WRITER_CAP: usize = 1024;
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

enum WsOut {
    Text(String),
    Binary(Vec<u8>),
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

    if !authenticate(&mut stream, &state, addr, &tx).await {
        writer.abort();
        return;
    }

    // Fan control-plane events out to this client.
    let mut events_rx = state.events.subscribe();
    let tx_ctrl = tx.clone();
    let control = tokio::spawn(async move {
        loop {
            match events_rx.recv().await {
                Ok(ev) => {
                    if let Ok(s) = serde_json::to_string(&ev.to_event()) {
                        if tx_ctrl.send(WsOut::Text(s)).await.is_err() {
                            break;
                        }
                    }
                }
                // Dropped control events leave the client with stale thread
                // state; tell it to refetch rather than silently diverge.
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
                match req.method.as_str() {
                    "auth" => {
                        let _ = tx
                            .send(WsOut::Text(json_str(&Response::ok(id, json!({ "ok": true })))))
                            .await;
                    }
                    "thread.attach" => {
                        handle_attach(&state, &req.params, id, &tx, &mut attached).await;
                    }
                    "thread.detach" => {
                        if let Some(tid) = req.params.get("threadId").and_then(|v| v.as_str()) {
                            if let Some(h) = attached.remove(tid) {
                                h.abort();
                            }
                        }
                        let _ = tx
                            .send(WsOut::Text(json_str(&Response::ok(id, json!({ "ok": true })))))
                            .await;
                    }
                    _ => {
                        let resp = match rpc::dispatch(&state, &req.method, req.params).await {
                            Ok(v) => Response::ok(id, v),
                            Err(e) => Response::err(id, e),
                        };
                        let _ = tx.send(WsOut::Text(json_str(&resp))).await;
                    }
                }
            }
            Message::Binary(bytes) => {
                if let Some((op, tid, payload)) = protocol::parse_frame(&bytes) {
                    // Only accept input for threads THIS socket attached to:
                    // a known UUID alone must not let one client inject
                    // keystrokes into another's PTY.
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

async fn authenticate(
    stream: &mut SplitStream<WebSocket>,
    state: &Arc<AppState>,
    addr: SocketAddr,
    tx: &mpsc::Sender<WsOut>,
) -> bool {
    let ip = addr.ip();
    if state.auth.is_locked(ip) {
        return false;
    }
    let first = tokio::time::timeout(AUTH_TIMEOUT, stream.next()).await;
    // A frame that is not a well-formed auth request still has to reach
    // auth.verify: routing malformed or wrong-method first frames around it
    // left the per-IP lockout untrippable by exactly the traffic a prober
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
                            .get("token")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    )
                })
                // A text frame that is not a usable auth request is still an
                // attempt: that is what a prober sends.
                .unwrap_or((0, String::new())),
        ),
        Ok(Some(Ok(Message::Binary(_)))) => Some((0, String::new())),
        // Close/Ping/Pong and the timeout are NOT attempts. A client that hangs
        // up before authenticating (tab closed, network blip, connectivity
        // probe) sends a Close frame, and counting it locked the IP out after
        // five reconnects — a PWA banning its own device.
        _ => None,
    };

    if let Some((id, token)) = attempt {
        if state.auth.verify(ip, &token) {
            let _ = tx
                .send(WsOut::Text(json_str(&Response::ok(
                    id,
                    json!({ "ok": true }),
                ))))
                .await;
            return true;
        }
    }
    let _ = tx
        .send(WsOut::Text(json_str(&Response::err(0, "auth failed".into()))))
        .await;
    false
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
