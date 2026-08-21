mod agent_api;
mod auth;
mod authz;
mod cli;
mod config;
mod events;
mod http;
mod notify;
mod pairing_link;
mod protocol;
mod push;
mod registry;
mod rpc;
mod secret_file;
mod state;
mod ws;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::connect_info::ConnectInfo;
use axum::extract::{RawQuery, State, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use axum::http::{header, HeaderValue};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use auth::Auth;
use boite_core::scope::ProjectRoots;
use config::Config;
use events::AppEvent;
use registry::Registry;
use state::AppState;
use boite_core::store::{ColVal, Store, ThreadCol};

const EVENT_CHANNEL_CAP: usize = 1024;
const MAX_WS_MESSAGE: usize = 1024 * 1024;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "boite_server=info".into()),
        )
        .init();

    // A headless box with nothing paired to it has no screen to pair the first
    // device from. These verbs are that screen; they touch the database and
    // exit without ever binding a port, so they work whether or not a server is
    // already running on this data directory.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if cli::is_command(&args) {
        std::process::exit(cli::run(&args));
    }

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[boite-server] config error: {e}");
            std::process::exit(1);
        }
    };
    let app_start = std::time::Instant::now();
    let telemetry = Some(Arc::new(boite_core::telemetry::TelemetryRuntime::spawn(
        &config.data_dir,
        env!("CARGO_PKG_VERSION"),
        "server",
        app_start,
    )));

    let db_path = config.data_dir.join("boite.db");
    let store = match Store::open(&db_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[boite-server] store error: {e}");
            std::process::exit(1);
        }
    };
    // Before anything can read a row. Every PTY this process will own is one it
    // spawns itself, so a row still naming a process names one of the last
    // server's, and a client connecting now has to be told that thread was cut
    // off rather than that it never started.
    if let Err(e) = store.settle_last_run() {
        tracing::warn!("settling the last run's thread statuses failed: {e}");
    }
    let store = Arc::new(store);

    let (events, _) = broadcast::channel::<AppEvent>(EVENT_CHANNEL_CAP);
    let emit = make_event_emitter(store.clone(), events.clone());
    // The status ticker needs to know which threads are claude's and which
    // session each holds, so it can ask claude itself instead of inferring a
    // turn from an OSC title that stopped arriving. Those two columns live in
    // the thread table, which the PTY registry has no business owning.
    let identity = {
        let store = store.clone();
        Arc::new(move |thread_id: &str| {
            store
                .load_thread(thread_id)
                .ok()
                .flatten()
                .map(|t| registry::ThreadIdentity {
                    icon_key: t.icon_key,
                    session_id: t.session_id,
                })
        }) as registry::IdentityLookup
    };
    // Beside the database. A transcript is the only record of what an agent
    // actually did in its terminal, and it used to die with the process.
    let transcripts = config.data_dir.join("transcripts");
    let transcripts = match std::fs::create_dir_all(&transcripts) {
        Ok(()) => Some(transcripts),
        Err(e) => {
            tracing::warn!("terminals run without a transcript: {e}");
            None
        }
    };
    let registry = Registry::new(config.scrollback_bytes, transcripts, emit, identity);
    // Shared rather than owned by the state: the agent endpoint decides where a
    // project may be created, and it has to read the same boundary the RPC does,
    // including every refresh after a project is added.
    let roots = Arc::new(ProjectRoots::default());
    let notifier = notify::Notifier::from_env();
    let push = push::PushManager::load(&config.data_dir);

    // Loopback only, and a secret of its own: the main server may be bound to a
    // routable interface, and an agent appending to a checklist is not the same
    // principal as a device driving the workspace.
    let devices = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // One wait registry for the whole process: the RPC's writes wake the agent
    // endpoint's long-polls, so the two must hold the same one.
    let pulse = boite_core::pulse::Waiters::new();
    let agent_api = agent_api::start(
        store.clone(),
        events.clone(),
        roots.clone(),
        &config,
        devices.clone(),
        registry.clone(),
        pulse.clone(),
    )
    .await;

    let state = Arc::new(AppState {
        store,
        agent_api,
        registry,
        auth: Auth::new(config.bootstrap_token.clone()),
        roots,
        events: events.clone(),
        notifier,
        push,
        max_threads: config.max_threads,
        max_connections: config.max_connections,
        conns: std::sync::atomic::AtomicUsize::new(0),
        devices,
        workspace_dir: config.workspace_dir,
        data_dir: config.data_dir,
        public_url: config.public_url,
        claimed_requests: Default::default(),
        pulse,
        telemetry,
    });

    if let Err(e) = state.refresh_roots() {
        tracing::warn!("failed to load project roots: {e}");
    }

    // One task drives every outbound notification on thread transitions: the
    // optional webhook plus Web Push. Push is always on (keys are generated at
    // first run), so the task runs unconditionally; each sink no-ops when it has
    // nothing to deliver (webhook unconfigured / no push subscriptions).
    if state.notifier.enabled() {
        tracing::info!("webhook notifications enabled");
    }
    tracing::info!("web push enabled (VAPID public key in data dir)");
    spawn_notifier_task(state.clone(), events.subscribe());

    // Never log the token itself: logs land in journald/docker/CI where the
    // on-disk token file's 0600 protection does not apply. The operator reads
    // it from the data dir (or sets BOITE_TOKEN).
    tracing::info!(
        "bootstrap token loaded ({} chars); it pairs devices and opens nothing else",
        config.bootstrap_token.len()
    );
    match state.store.list_pairings() {
        Ok(rows) => {
            let live = rows.iter().filter(|r| !r.revoked()).count();
            if live == 0 {
                // Not a warning, because it is also what a fresh install looks
                // like. It is the one sentence that turns "nothing connects any
                // more" into a next step.
                tracing::info!(
                    "no device is paired with this boite yet. `boite-server pair` invites one, \
                     or POST /api/pairings with the bootstrap token"
                );
            } else {
                tracing::info!("{live} device(s) paired");
            }
        }
        Err(e) => tracing::warn!("could not read the pairing list: {e}"),
    }
    tracing::info!("listening on {}", config.bind);
    if !config.bind.starts_with("127.") && !config.bind.starts_with("[::1]") {
        tracing::warn!(
            "bound to a routable interface ({}); credentials are sent over plain http:// \
             and ws:// unless you front it with TLS (reverse proxy) or a tunnel \
             (WireGuard/SSH)",
            config.bind
        );
    }

    let mut app = Router::new()
        .route("/api/health", get(health))
        .route("/.well-known/assetlinks.json", get(assetlinks))
        // The three doors that are not the socket. See `crate::http`: each one
        // takes its credential in a header or a body, so none of them can leave
        // a secret in a reverse proxy's access log.
        .route("/api/pairings", post(http::mint_pairing))
        .route("/api/pair", post(http::pair))
        .route("/api/ticket", post(http::ticket))
        .route("/ws", get(ws_upgrade));

    if let Some(dir) = &config.static_dir {
        let index = dir.join("index.html");
        let serve = ServeDir::new(dir).fallback(ServeFile::new(index));
        // The same SPA the desktop window runs, served to a phone or a browser
        // — and until now with none of the protection the desktop window has.
        // Tauri hands the webview a strict CSP from tauri.conf.json; this door
        // sent the identical files with no CSP, no nosniff and no framing rule
        // at all.
        //
        // What is set here is the half that cannot break a page: no
        // `script-src`, no `style-src`, no `connect-src`. That is deliberate
        // rather than lazy. adapter-static emits one inline `<script>` of about
        // 320 bytes to start the app, its hash changes every build, and a
        // `script-src 'self'` here would leave a phone staring at a blank page
        // with the reason only in a console it cannot open. Locking the script
        // side down properly means SvelteKit's own `kit.csp` in hash mode, so
        // the hash is generated with the file it covers — its own change, with
        // the desktop CSP checked against it, not a line snuck in here.
        //
        // `frame-ancestors 'none'` and `X-Frame-Options` say the same thing to
        // two generations of browser: a boite is not something to embed. It
        // drives terminals, and a click landing on one through a transparent
        // overlay is a real command in a real shell.
        app = app
            .fallback_service(serve)
            .layer(SetResponseHeaderLayer::overriding(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(
                    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
                ),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                header::X_FRAME_OPTIONS,
                HeaderValue::from_static("DENY"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ))
            // A boite is reached over plain http on a LAN as often as not, and
            // the referrer of a page served from one leaks the host and port it
            // lives at to anything it links out to.
            .layer(SetResponseHeaderLayer::overriding(
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            ));
    }

    let registry_for_shutdown = state.registry.clone();
    let telemetry_for_shutdown = state.telemetry.clone();
    let app = app.with_state(state.clone());

    let listener = match tokio::net::TcpListener::bind(&config.bind).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[boite-server] bind {} failed: {e}", config.bind);
            std::process::exit(1);
        }
    };

    if let Some(telemetry) = &state.telemetry {
        telemetry.on_boot_complete();
        let live = state.registry.pty_manager().live_count() as u64;
        telemetry.track_workspace_from(&state.store, live);
    }

    let serve = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    );

    if let Err(e) = serve
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutdown: killing PTYs");
            // kill_all spawns + joins one OS thread per PTY; keep it off the
            // async worker so a slow killer syscall can't stall the runtime.
            let _ = tokio::task::spawn_blocking(move || {
                if let Some(telemetry) = telemetry_for_shutdown {
                    telemetry.on_session_end();
                    telemetry.shutdown();
                }
                registry_for_shutdown.pty_manager().kill_all();
            })
            .await;
        })
        .await
    {
        tracing::error!("server error: {e}");
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health() -> &'static str {
    "ok"
}

// Digital Asset Links for the Android TWA: proves boite.net.tasbem.ch and the
// signed APK belong together so the browser drops the URL bar. The file is
// dropped into the data dir after the APK is built (it carries the signing
// cert SHA-256), so it is served from disk, not baked into the binary. 404
// until present, which is harmless for the PWA.
async fn assetlinks(State(state): State<Arc<AppState>>) -> Response {
    let path = state.data_dir.join("assetlinks.json");
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            bytes,
        )
            .into_response(),
        Err(_) => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

/// Upgrades to the socket, and refuses one that carries a secret in its URL.
///
/// The query string of an upgrade request reaches the access log of whatever
/// reverse proxy is in front, and nobody rotates those. Nothing here has ever
/// read one — the credential arrives in the first frame — so a request carrying
/// `?token=` or `?ticket=` is either a client built against a design this
/// server does not have or somebody trying the shape on. Both get the same
/// answer, and it is a refusal rather than a silently ignored parameter: a
/// client that thinks it authenticated in the URL should find out here rather
/// than at a five-second timeout.
async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    RawQuery(query): RawQuery,
) -> Response {
    if let Some(query) = query {
        let smells_of_a_secret = query
            .split('&')
            .filter_map(|pair| pair.split('=').next())
            .any(|key| matches!(key, "token" | "ticket" | "auth" | "credential"));
        if smells_of_a_secret {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                "a credential does not travel in a URL; present a ticket in the first frame",
            )
                .into_response();
        }
    }
    // tungstenite defaults to a 64 MiB message and a 16 MiB frame, and the
    // first frame on this socket arrives before the ticket is checked: an
    // unauthenticated peer could make the process buffer that much, times
    // `max_connections`, before anything decided who it was. Nothing a client
    // sends is anywhere near it — the widest legitimate message is a paste on
    // its way to a PTY — so a megabyte leaves room to spare and takes the
    // pre-auth cost down by a factor of sixty-four.
    ws.max_message_size(MAX_WS_MESSAGE)
        .max_frame_size(MAX_WS_MESSAGE)
        .on_upgrade(move |socket| ws::handle_socket(socket, state, addr))
        .into_response()
}

// Persist critical thread transitions before fanning them out. Broadcast is a
// lossy delivery mechanism under load; durable state must not depend on a
// receiver task keeping up.
fn make_event_emitter(
    store: Arc<Store>,
    tx: broadcast::Sender<AppEvent>,
) -> Arc<dyn Fn(AppEvent) + Send + Sync> {
    Arc::new(move |event: AppEvent| {
        match &event {
            AppEvent::ThreadStatus {
                thread_id,
                status,
                exit_code,
            } => {
                // What the row keeps is how the run ended, or that there was one.
                // `running`, `ready` and `waiting` all say the same thing to a
                // later boot — this thread was on — so they store the one word,
                // and `stopped` stores nothing at all: an auto-sleep is this
                // run's own bookkeeping, and writing it would make
                // `settle_last_run` decay the mark one restart early, which is a
                // thread that was on last session drawn as one that never ran.
                let stored = match status.as_str() {
                    "running" | "ready" | "waiting" => Some("running"),
                    "done" | "exited" | "error" => Some(status.as_str()),
                    _ => None,
                };
                if let Some(stored) = stored {
                    if let Err(e) = store.update_thread_field(
                        thread_id,
                        ThreadCol::Status,
                        ColVal::Text(stored.to_string()),
                    ) {
                        tracing::warn!("failed to persist thread status: {e}");
                    }
                }
                if let Some(c) = exit_code {
                    if let Err(e) =
                        store.update_thread_field(thread_id, ThreadCol::ExitCode, ColVal::Int(*c as i64))
                    {
                        tracing::warn!("failed to persist thread exit code: {e}");
                    }
                }
            }
            AppEvent::ThreadTitle { thread_id, title } => {
                if let Err(e) =
                    store.update_thread_field(thread_id, ThreadCol::Title, ColVal::Text(title.clone()))
                {
                    tracing::warn!("failed to persist thread title: {e}");
                }
            }
            _ => {}
        }
        let _ = tx.send(event);
    })
}

/// One line for a request the user has to answer, in the endpoint's own verbs.
///
/// Spelled out rather than templated from the action, so a verb this build has
/// never heard of still says something: a notification nobody can read is worth
/// as little as the one that was never sent.
fn approval_sentence(action: &str, detail: &str) -> String {
    match action {
        "thread.move" => format!("Wants to move to {detail}"),
        "project.create" => format!("Wants to create the project {detail}"),
        "thread.spawn" => format!("Wants a terminal in {detail}"),
        _ => format!("{action}: {detail}"),
    }
}

/// Everything a device is told about a thread, in one value.
///
/// Both paths take the same `Awareness`, so ntfy, Discord, a generic JSON
/// consumer and the PWA cannot say four different things about one event. What
/// they still differ in is the envelope, which is the only thing that is
/// genuinely per-transport.
async fn announce(state: &AppState, a: &boite_core::awareness::Awareness) {
    state.notifier.send(a).await;
    state.push.notify_all(&state.store, a).await;
}

// Fire a webhook on meaningful thread transitions: a turn finishing
// (running -> ready, claude awaiting input) and process exit. Tracks the last
// status per thread so a status that did not actually cross an edge is silent.
//
// Approvals go down the same paths, and for a stronger reason: nothing at all
// moves until one is answered, and the device most likely to be holding the
// answer is a phone with the app closed. The socket event alone only reaches a
// client that is already connected and looking.
fn spawn_notifier_task(state: Arc<AppState>, mut rx: broadcast::Receiver<AppEvent>) {
    use boite_core::awareness::{self, Facts};
    use boite_core::status::ThreadStatus;
    use std::collections::{HashMap, HashSet};
    tokio::spawn(async move {
        let mut last: HashMap<String, String> = HashMap::new();
        // Seeded from the table rather than left empty: the rows outlive the
        // process, and a restart would otherwise announce every request that
        // was already waiting as if it had just arrived.
        let mut announced: HashSet<String> = state
            .store
            .open_approvals()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.id)
            .collect();
        loop {
            match rx.recv().await {
                Ok(AppEvent::ThreadStatus {
                    thread_id,
                    status,
                    exit_code,
                }) => {
                    let prev = last.insert(thread_id.clone(), status.clone());
                    if prev.as_deref() == Some(status.as_str()) {
                        continue;
                    }
                    let fire = match status.as_str() {
                        // A turn that ended. Not from `waiting`: dismissing a
                        // dialog without answering is not the agent finishing.
                        "ready" => prev.as_deref() == Some("running"),
                        // Always worth a buzz: nothing moves until the user
                        // answers, so this is the one status that is a request.
                        "waiting" => true,
                        "exited" | "error" | "done" => true,
                        _ => false,
                    };
                    if !fire {
                        continue;
                    }
                    let Some(parsed) = ThreadStatus::parse(&status) else {
                        continue;
                    };
                    let who = state.store.thread_context(&thread_id);
                    // Read off the registry rather than off the event, because
                    // the difference between the two is what tells a turn that
                    // ended from a row left behind by a process that is gone.
                    // `exited` and friends arrive precisely as the entry is
                    // dropped, so they answer false and are meant to.
                    let has_process = state.registry.live(&thread_id).is_some();
                    // Only the phase that has one. A thread can be `waiting` on
                    // a dialog its agent drew, which is not a row anywhere, and
                    // asking the table on every transition would be a query per
                    // event to answer "no" almost every time.
                    let approval = if parsed == ThreadStatus::Waiting {
                        state
                            .store
                            .open_approvals()
                            .unwrap_or_default()
                            .into_iter()
                            .find(|p| p.thread_id == thread_id)
                            .map(|p| approval_sentence(&p.action, &p.detail))
                    } else {
                        None
                    };
                    let aware = awareness::derive(&Facts {
                        thread_id: &thread_id,
                        label: who.as_ref().map(|w| w.label.as_str()).unwrap_or("thread"),
                        project_id: who.as_ref().and_then(|w| w.project_id.as_deref()),
                        project: who.as_ref().and_then(|w| w.project.as_deref()),
                        status: parsed,
                        exit_code,
                        has_process,
                        approval: approval.as_deref(),
                    });
                    announce(&state, &aware).await;
                }
                // The event carries nothing, so the table answers what changed.
                // Ids rather than a count: answering one and opening another in
                // the same breath leaves the count where it was, and the new
                // request would go unannounced.
                Ok(AppEvent::ApprovalsChanged) => {
                    let open = state.store.open_approvals().unwrap_or_default();
                    let fresh: Vec<_> = open
                        .iter()
                        .filter(|p| !announced.contains(&p.id))
                        .collect();
                    // Rebuilt from what is still open, so an answered request
                    // stops being remembered and the set cannot grow forever.
                    let next: HashSet<String> = open.iter().map(|p| p.id.clone()).collect();
                    if fresh.is_empty() {
                        announced = next;
                        continue;
                    }
                    // One request gets the thread's own card, with a link to the
                    // terminal that asked. Several get a count and a link to
                    // none of them: opening one of four arbitrarily is worse
                    // than opening the app, and the dock lists them all anyway.
                    let aware = if let [only] = fresh.as_slice() {
                        let who = state.store.thread_context(&only.thread_id);
                        awareness::derive(&Facts {
                            thread_id: &only.thread_id,
                            label: who
                                .as_ref()
                                .map(|w| w.label.as_str())
                                .unwrap_or("An agent"),
                            project_id: who.as_ref().and_then(|w| w.project_id.as_deref()),
                            project: who.as_ref().and_then(|w| w.project.as_deref()),
                            status: ThreadStatus::Waiting,
                            exit_code: None,
                            has_process: state.registry.live(&only.thread_id).is_some(),
                            approval: Some(&approval_sentence(&only.action, &only.detail)),
                        })
                    } else {
                        awareness::Awareness {
                            phase: awareness::Phase::WaitingForApproval.as_str(),
                            headline: "Boite needs your approval".to_string(),
                            detail: format!("{} requests need an answer", fresh.len()),
                            thread_id: String::new(),
                            thread: "Boite".to_string(),
                            project_id: None,
                            project: None,
                            link: "/".to_string(),
                        }
                    };
                    announced = next;
                    announce(&state, &aware).await;
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::approval_sentence;

    #[test]
    fn each_gated_call_says_what_it_is_asking_for() {
        assert_eq!(
            approval_sentence("thread.move", "Boite"),
            "Wants to move to Boite"
        );
        assert_eq!(
            approval_sentence("project.create", "notes"),
            "Wants to create the project notes"
        );
        assert_eq!(
            approval_sentence("thread.spawn", "Boite"),
            "Wants a terminal in Boite"
        );
    }

    /// A verb this build has never heard of still produces a line. The dock
    /// draws an unknown action rather than dropping the card, and a
    /// notification that said nothing would be the one place the two disagree.
    #[test]
    fn an_action_with_no_sentence_still_gets_one() {
        assert_eq!(approval_sentence("thread.eat", "lunch"), "thread.eat: lunch");
    }
}
