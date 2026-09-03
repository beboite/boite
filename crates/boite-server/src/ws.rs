use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
use crate::registry::{self, ClientId};
use crate::rpc;
use crate::state::AppState;

const WRITER_CAP: usize = 1024;
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

/// How stale the PTY paths let their answer to "is this device still paired"
/// get.
///
/// Two seconds, and the number is a compromise with a reason on both sides.
/// Asking the database per frame is one indexed read per keystroke *and* per
/// output chunk, and a `cat` of a build log is thousands of chunks a second
/// through a connection every other terminal in the workspace shares. The lock,
/// not the read, is what would hurt. Never asking is the hole this constant
/// exists to close. Two seconds is shorter than it takes to type
/// anything into a shell you have just been thrown out of.
const REVOKE_RECHECK: Duration = Duration::from_secs(2);

/// Whether this connection's pairing is still live, asked of the row rather
/// than of a broadcast.
///
/// Text RPCs read the row on every call (`authz::Authorized::check`). The two
/// paths that carry PTY bytes did not: input frames were gated on an atomic set
/// only by [`AppEvent::PairingRevoked`], and the attach forward loop re-checked
/// nothing at all. That leaves one gap wide open: `boite-server revoke` writes
/// the row from a *second process* (SQLite is in WAL mode, which is what makes
/// that safe), so this process broadcasts nothing and the atomic never flips.
/// A device attached to a PTY and sending only keystrokes makes no text RPC, so
/// it kept full terminal I/O across a revocation that had already been written.
///
/// So both paths ask here, and the answer is cached for [`REVOKE_RECHECK`] to
/// keep a per-frame database hit off the hot path of every terminal.
struct Liveness {
    pairing_id: String,
    /// Monotonic, so a wall clock stepping backwards cannot widen the window.
    since: Instant,
    checked_at_ms: AtomicU64,
    live: AtomicBool,
}

impl Liveness {
    fn new(pairing_id: &str) -> Liveness {
        Liveness {
            pairing_id: pairing_id.to_string(),
            since: Instant::now(),
            // The handshake that just happened is the first check, so the first
            // read of the row is a whole window away.
            checked_at_ms: AtomicU64::new(0),
            live: AtomicBool::new(true),
        }
    }

    /// True while this device may still move bytes through a PTY.
    ///
    /// Once it has answered false it stays false without touching the database
    /// again: a revocation is not something the next read can undo, and
    /// re-pairing is a new pairing on a new socket.
    fn allows(&self, store: &boite_core::store::Store) -> bool {
        self.allows_at(self.since.elapsed().as_millis() as u64, store)
    }

    /// The whole of [`Liveness::allows`] with the clock passed in, so the
    /// window can be tested without a test that sleeps through it.
    fn allows_at(&self, now_ms: u64, store: &boite_core::store::Store) -> bool {
        if !self.live.load(Ordering::Relaxed) {
            return false;
        }
        let last = self.checked_at_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) < REVOKE_RECHECK.as_millis() as u64 {
            return true;
        }
        self.checked_at_ms.store(now_ms, Ordering::Relaxed);
        let live = store.pairing_is_live(&self.pairing_id);
        self.live.store(live, Ordering::Relaxed);
        live
    }

    /// What the control task calls when the broadcast got here first. Nothing
    /// then waits for the window: revocation from this process is immediate,
    /// and the re-read is what covers the process that cannot broadcast.
    fn revoked(&self) {
        self.live.store(false, Ordering::Relaxed);
    }
}

/// Tells the client it is out, then hangs up.
///
/// A socket that merely stops carrying bytes is one the user watches sit there
/// looking connected. Whichever path notices first says it; the writer stops at
/// the first `Close`, so a second caller is a no-op.
async fn hang_up(tx: &mpsc::Sender<WsOut>) {
    let _ = tx
        .send(WsOut::Text(json_str(&Response::err(
            0,
            crate::authz::REVOKED.to_string(),
        ))))
        .await;
    let _ = tx.send(WsOut::Close).await;
}

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

    // The gate the two PTY paths ask, and the one the control task trips when
    // the revocation was broadcast by this process. An RPC asks the database on
    // every call (see `authz::Authorized::check`); a socket carrying only
    // keystrokes makes no RPC, which is what this is for.
    let liveness = Arc::new(Liveness::new(session.pairing_id()));

    // Fan control-plane events out to this client.
    let mut events_rx = state.events.subscribe();
    let tx_ctrl = tx.clone();
    let state_ctrl = state.clone();
    let my_pairing = session.pairing_id().to_string();
    let liveness_ctrl = liveness.clone();
    let control = tokio::spawn(async move {
        loop {
            match events_rx.recv().await {
                Ok(AppEvent::PairingRevoked { pairing_id }) if pairing_id == my_pairing => {
                    // This connection is over. Said once so the client can put
                    // the login gate up rather than reconnect into a refusal,
                    // then hung up: a socket that merely refuses every call is
                    // one the user watches sit there looking connected.
                    liveness_ctrl.revoked();
                    hang_up(&tx_ctrl).await;
                    break;
                }
                // A live log feed goes only to the devices that asked. Every
                // other event is for everyone: this is the one whose volume
                // makes "fan out and let the client filter" the wrong shape.
                Ok(AppEvent::LogRecords { .. })
                    if !state_ctrl.logs_subscribed(&my_pairing) => {}
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
    // Who this connection is, as far as terminal sizing is concerned. A PTY has
    // one size and several devices can be watching it, so the registry has to
    // be able to tell them apart: see `registry::Sizing`.
    let client: ClientId = registry::new_client_id();

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
                        handle_attach(
                            &state,
                            request.params(),
                            id,
                            &tx,
                            &mut attached,
                            &liveness,
                            client,
                        )
                        .await;
                    }
                    // Served here rather than in `rpc::dispatch` for the same
                    // reason attach and detach are: the answer depends on which
                    // socket asked. A PTY has one size and several devices can
                    // be attached to it, so a resize from a client that is only
                    // watching is recorded and goes no further. The size
                    // follows whoever is typing. See `registry::Sizing`.
                    "thread.resize" => {
                        let p = request.params();
                        let resp = match (
                            p.get("threadId").and_then(|v| v.as_str()),
                            p.get("cols").and_then(|v| v.as_u64()),
                            p.get("rows").and_then(|v| v.as_u64()),
                        ) {
                            (Some(tid), Some(cols), Some(rows)) => {
                                match state.registry.resize(tid, client, cols as u16, rows as u16) {
                                    Ok(()) => Response::ok(id, json!({ "ok": true })),
                                    Err(e) => Response::err(id, e),
                                }
                            }
                            _ => Response::err(id, "missing param: threadId, cols or rows".into()),
                        };
                        let _ = tx.send(WsOut::Text(json_str(&resp))).await;
                    }
                    "thread.detach" => {
                        if let Some(tid) = request.params().get("threadId").and_then(|v| v.as_str())
                        {
                            if let Some(h) = attached.remove(tid) {
                                h.abort();
                            }
                            // Told before the reply goes out: if this client was
                            // the one the PTY was sized for, another attached
                            // device takes it over now rather than at its next
                            // keystroke.
                            state.registry.detach(tid, client);
                        }
                        let _ = tx
                            .send(WsOut::Text(json_str(&Response::ok(id, json!({ "ok": true })))))
                            .await;
                    }
                    _ => {
                        // Which device, because "it works from my phone" is the
                        // whole of what a bug report usually carries, and a
                        // refusal with no device in it cannot be told from a
                        // failure everyone is seeing.
                        let refused_method = request.method().to_string();
                        let refused_thread = request
                            .params()
                            .get("threadId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let refused_device = request.device().to_string();
                        let resp = match rpc::dispatch(&state, request).await {
                            Ok(v) => Response::ok(id, v),
                            Err(e) => {
                                tracing::warn!(
                                    method = %refused_method,
                                    thread = %refused_thread,
                                    device = %refused_device,
                                    reason = %e,
                                    "rpc.failed"
                                );
                                Response::err(id, e)
                            }
                        };
                        let _ = tx.send(WsOut::Text(json_str(&resp))).await;
                    }
                }
            }
            Message::Binary(bytes) => {
                // A revoked device stops typing into a terminal at once, which
                // is the case a check at the next RPC would miss entirely: a
                // socket carrying only keystrokes makes no RPCs. The row, not
                // just the broadcast, because `boite-server revoke` is a second
                // process and broadcasts nothing.
                if !liveness.allows(&state.store) {
                    hang_up(&tx).await;
                    break;
                }
                if let Some((op, tid, payload)) = protocol::parse_frame(&bytes) {
                    // Only accept input for threads THIS socket attached to:
                    // a known UUID alone must not let one client inject
                    // keystrokes into another's PTY. Attaching is gated on the
                    // terminal scope, so this set is empty for a device that
                    // does not hold one.
                    if op == protocol::FRAME_INPUT && attached.contains_key(&tid.to_string()) {
                        // `input` rather than `write`: typing is what makes a
                        // client the one the PTY is sized for, so this is also
                        // where a watching device becomes the driving one.
                        let _ = state.registry.input(&tid.to_string(), client, payload);
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // A socket that just went away is a client that detached from everything it
    // held. Said out loud, or a laptop closing its lid would leave every PTY it
    // was driving sized for a device that is no longer there.
    for (thread_id, h) in attached {
        h.abort();
        state.registry.detach(&thread_id, client);
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
    liveness: &Arc<Liveness>,
    client: ClientId,
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

    // Not a detach: the same client re-attaching to the same terminal keeps
    // whatever standing it had, and handing the size to somebody else only to
    // take it straight back would resize the PTY twice for nothing.
    match state.registry.attach(&thread_id, client, cols, rows, since) {
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
            let store = state.store.clone();
            let live = liveness.clone();
            let h = tokio::spawn(async move {
                loop {
                    let received = rxf.recv().await;
                    // Output is the other half of terminal access, and this
                    // task never re-checked anything: a revoked device that
                    // stops typing would keep watching the PTY for as long as
                    // it stayed connected. Between the two branches rather than
                    // inside one, because the lagged branch resends the entire
                    // scrollback. Per chunk, answered from cache between reads
                    // (see `Liveness`).
                    if !live.allows(&store) {
                        hang_up(&txf).await;
                        break;
                    }
                    match received {
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

#[cfg(test)]
mod tests {
    use super::*;
    use boite_core::pairing::{Pairing, ScopeSet};
    use boite_core::store::Store;

    fn store_with_one_pairing(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("boite-ws-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("boite.db")).unwrap();
        store
            .add_pairing(
                &Pairing {
                    id: "phone".into(),
                    label: "a phone".into(),
                    kind: "phone".into(),
                    scopes: ScopeSet::full(),
                    created_at: 1,
                    last_seen_at: None,
                    revoked_at: None,
                },
                "hash",
            )
            .unwrap();
        (store, dir)
    }

    /// The hole `boite-server revoke` left open. That command is a second
    /// process, so it broadcasts nothing; a device attached to a PTY and
    /// sending only keystrokes makes no RPC and was never asked again. The gate
    /// reads the row, so it closes anyway.
    #[test]
    fn a_revocation_nobody_broadcast_still_closes_the_terminal() {
        let (store, dir) = store_with_one_pairing("revoked-elsewhere");
        let gate = Liveness::new("phone");
        assert!(gate.allows_at(0, &store));

        // Written by the other process. No AppEvent, so nothing in here heard.
        store.revoke_pairing("phone", 2).unwrap();

        // Inside the window the cached answer still stands, which is the price
        // of not hitting the database per keystroke.
        assert!(gate.allows_at(REVOKE_RECHECK.as_millis() as u64 - 1, &store));
        // Past it, the row is read and the terminal is over.
        assert!(!gate.allows_at(REVOKE_RECHECK.as_millis() as u64, &store));
        // And it stays over without asking again, whatever the clock says.
        assert!(!gate.allows_at(0, &store));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pairing nobody revoked keeps working past any number of windows, and
    /// the broadcast path shuts one down without waiting for the next read.
    #[test]
    fn a_live_pairing_keeps_its_terminal_and_a_broadcast_ends_one_at_once() {
        let (store, dir) = store_with_one_pairing("still-live");
        let gate = Liveness::new("phone");
        for tick in 0..10 {
            assert!(gate.allows_at(tick * REVOKE_RECHECK.as_millis() as u64, &store));
        }
        gate.revoked();
        assert!(!gate.allows_at(0, &store));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
