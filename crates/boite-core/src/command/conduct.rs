//! The orchestration surface: the pulse, the orchestrator conversation, and
//! the dispatch queue.
//!
//! Small on purpose, and grown phase by phase. Phase 1 brought a worker's
//! phase transitions written down (`conduct.record`), read back with an
//! optional wait (`conduct.pulse`), and the durable chat the user and the
//! orchestrator share (`orchestrator.post` / `orchestrator.say` /
//! `orchestrator.messages`). Phase 3 adds the dispatch queue: a dispatch is a
//! row, never a byte (`crate::reply` forbids typing from the bus, on purpose,
//! and this does not go around it). `thread.dispatch` queues the line, the
//! device that owns the target PTY drains and types it (`dispatch.drain`,
//! guards in `crate::orchestrator::dispatch`), and reports what happened
//! (`dispatch.settle`). `thread.acceptDispatch` is the user's mute switch.
//!
//! The wait is the part with rules. `conduct.pulse` long-polls the ring through
//! `crate::pulse::Waiters`, which caps the timeout at 120 s, allows one live
//! wait per calling thread (a second one supersedes the first, named
//! `PULSE_SUPERSEDED`), and eight per process (`PULSE_BUSY`). A host that wires
//! no waiters — a test, the desktop window today — answers immediately with
//! `timedOut: true`, which is honest: nothing was waited on.

use std::sync::Arc;

use serde_json::{json, Value};

use super::{opt_str_param, str_param, u32_param, value_of, Host, Ready, Wire};
use crate::capability::{Capability, Grant};
use crate::pulse::{self, Waiters};
use crate::store::Store;

/// Every method in this domain, in the order they appear below.
pub const ALL_METHODS: &[&str] = &[
    "conduct.pulse",
    "conduct.record",
    "orchestrator.post",
    "orchestrator.say",
    "orchestrator.messages",
    "orchestrator.start",
    "orchestrator.status",
    "orchestrator.actions",
    "orchestrator.undo",
    "thread.dispatch",
    "thread.acceptDispatch",
    "dispatch.drain",
    "dispatch.settle",
    "voice.transcribe",
];

/// How long a queued line lives when the drain does not say otherwise.
const DISPATCH_TTL_MS_DEFAULT: u32 = 3_600_000;

/// The three words a settle may write. Anything else is a caller inventing a
/// state the readers of this table were never taught.
const SETTLE_STATES: &[&str] = &[
    crate::orchestrator::dispatch::STATE_DELIVERED,
    crate::orchestrator::dispatch::STATE_DROPPED,
    crate::orchestrator::dispatch::STATE_REFUSED,
];

/// How many moments one pulse answer carries at most.
const PULSE_LIMIT: usize = 500;

/// How many chat lines one read answers with when the caller says nothing.
const MESSAGES_LIMIT_DEFAULT: u32 = 50;
const MESSAGES_LIMIT_MAX: u32 = 500;

/// How many recorded actions one read answers with.
const ACTIONS_LIMIT_DEFAULT: u32 = 50;
const ACTIONS_LIMIT_MAX: u32 = 200;

/// Reads the pulse, waiting when it is quiet.
///
/// `pub` because the agent endpoint's `GET /v1/pulse` is the same read with a
/// different door: one implementation, or the two drift on what a timeout
/// answers with.
pub fn read_pulse(
    store: &Store,
    waiters: Option<&Arc<Waiters>>,
    since_seq: i64,
    timeout_ms: u64,
    project: Option<&str>,
    waiter: &str,
) -> Result<Value, String> {
    let timeout_ms = timeout_ms.min(pulse::MAX_TIMEOUT_MS);
    let (mut moments, mut truncated) = store.read_moments(since_seq, PULSE_LIMIT, project)?;
    let mut timed_out = false;
    if moments.is_empty() {
        match waiters {
            Some(waiters) if timeout_ms > 0 => match waiters.wait(waiter, timeout_ms)? {
                pulse::Outcome::Woken => {
                    let again = store.read_moments(since_seq, PULSE_LIMIT, project)?;
                    moments = again.0;
                    truncated = again.1;
                }
                pulse::Outcome::TimedOut => timed_out = true,
                pulse::Outcome::Superseded => {
                    // The agent doubled itself. A named error, never a lying
                    // timeout.
                    return Err(
                        "PULSE_SUPERSEDED: a newer pulse from the same caller replaced this one"
                            .to_string(),
                    );
                }
            },
            // No waiter registry on this host, or a zero timeout: an empty
            // answer now is the honest one.
            _ => timed_out = timeout_ms > 0,
        }
    }
    let seq = moments
        .last()
        .map(|m| m.seq)
        .unwrap_or_else(|| store.latest_moment_seq().max(since_seq));
    Ok(json!({
        "seq": seq,
        "moments": value_of(moments),
        "timedOut": timed_out,
        "truncated": truncated,
    }))
}

/// The orchestrator's line back into the chat. Shared with `POST /v1/say`.
///
/// The row is the proof: only a thread Boite stamped may speak as the
/// orchestrator, whatever the caller claims to be.
pub fn say(
    store: &Store,
    waiters: Option<&Arc<Waiters>>,
    thread_id: &str,
    text: &str,
    aloud: Option<&str>,
    urgency: Option<&str>,
) -> Result<Value, String> {
    let (role, scope, _) = store
        .thread_orchestration(thread_id)
        .ok_or("unknown thread")?;
    if role.as_deref() != Some(crate::orchestrator::ROLE) {
        return Err(
            "only an orchestrator thread may say something here, and this thread is not one"
                .to_string(),
        );
    }
    let id = store.add_orchestrator_message(
        scope.as_deref(),
        "orchestrator",
        text,
        aloud,
        urgency,
        crate::now_ms(),
    )?;
    // A moment too, so a window reading the pulse learns a reply landed
    // without polling the chat table.
    let seq = store.append_moment(
        "chat.said",
        scope.as_deref(),
        Some(&id),
        urgency.unwrap_or(""),
        "chat",
        crate::now_ms(),
    )?;
    if let Some(waiters) = waiters {
        waiters.notify();
    }
    Ok(json!({ "messageId": id, "seq": seq }))
}

/// The static guards every orchestrator-to-worker verb shares, answering the
/// target's project when they all pass.
///
/// The row is the proof of the caller's role, the target never carries a role
/// of its own, and the scope rule is the same both ways: a project
/// orchestrator stays inside its project, a global one stays out of a project
/// that has its own.
fn conducted_target(
    store: &Store,
    thread_id: &str,
    to_thread_id: &str,
) -> Result<String, String> {
    let (role, scope, _) = store
        .thread_orchestration(thread_id)
        .ok_or("unknown thread")?;
    if role.as_deref() != Some(crate::orchestrator::ROLE) {
        return Err(
            "only an orchestrator thread may reach another thread this way, and this thread \
             is not one"
                .to_string(),
        );
    }
    let (to_role, _, _) = store
        .thread_orchestration(to_thread_id)
        .ok_or("unknown target thread")?;
    if to_role.is_some() {
        return Err(
            "NO_ORCHESTRATOR_TO_ORCHESTRATOR: the target carries a role, and a \
             dispatch between orchestrators is refused in both directions"
                .to_string(),
        );
    }
    let target_project = store.project_of_thread(to_thread_id)?;
    match scope.as_deref() {
        // A global orchestrator stays out of a project another orchestrator
        // owns.
        None => {
            if store.find_orchestrator(Some(&target_project)).is_some() {
                return Err(format!(
                    "SCOPE_TAKEN: project {target_project} has its own live \
                     orchestrator, and dispatch into it belongs to that one"
                ));
            }
        }
        // A project orchestrator stays inside its own project.
        Some(own) if own != target_project => {
            return Err(format!(
                "OUT_OF_SCOPE: this orchestrator is scoped to {own} and the \
                 target lives in {target_project}"
            ));
        }
        Some(_) => {}
    }
    Ok(target_project)
}

/// Queues one line for another thread's prompt. Shared with `POST /v1/dispatch`.
///
/// The static guards run here, at queue time; the live ones — phase, a
/// permission on screen — are the device's at flush time
/// (`crate::orchestrator::dispatch`), and it re-checks these too: a row can
/// change between queue and flush.
pub fn dispatch(
    store: &Store,
    waiters: Option<&Arc<Waiters>>,
    thread_id: &str,
    to_thread_id: &str,
    text: &str,
    mode: &str,
) -> Result<Value, String> {
    let target_project = conducted_target(store, thread_id, to_thread_id)?;
    let (_, _, to_accepts) = store
        .thread_orchestration(to_thread_id)
        .ok_or("unknown target thread")?;
    if !to_accepts {
        return Err(
            "MUTED: the user muted dispatch into this thread, and only the user rearms it"
                .to_string(),
        );
    }
    let now = crate::now_ms();
    let id = store.queue_dispatch(thread_id, to_thread_id, text, mode, now)?;
    let seq = store.append_moment(
        "dispatch.queued",
        Some(&target_project),
        Some(&id),
        mode,
        "dispatch",
        now,
    )?;
    if let Some(waiters) = waiters {
        waiters.notify();
    }
    Ok(json!({ "dispatchId": id, "seq": seq }))
}

/// Un-does one recorded orchestrator action, on the user's word.
///
/// The table's own rule holds here: nothing committed is ever destroyed.
/// Undoing a spawn puts the worker away behind the same busy rule as any
/// settle; undoing a dismissal brings the thread back out. Both are stamps on
/// rows, never deletes, and a kind nothing here knows how to reverse is
/// refused by name rather than guessed at.
pub fn undo(
    store: &Store,
    waiters: Option<&Arc<Waiters>>,
    action_id: &str,
) -> Result<Value, String> {
    let (kind, object_id, undoable, undone) = store
        .orchestrator_action(action_id)
        .ok_or("unknown action")?;
    if undone {
        return Err("ALREADY_UNDONE: this action was already undone".to_string());
    }
    if !undoable {
        return Err(format!("NOT_UNDOABLE: a {kind} is not reversible from here"));
    }
    let object = object_id.ok_or("the action names no object to act on")?;
    let now = crate::now_ms();
    match kind.as_str() {
        "thread.spawn" => {
            let status = store
                .thread_status(&object)
                .map(|(status, _)| status)
                .unwrap_or_else(|| "idle".to_string());
            if !crate::settle::can_settle(&status) {
                return Err(crate::settle::refusal(&status));
            }
            store.update_thread_field(
                &object,
                crate::store::ThreadCol::SettledAt,
                crate::store::ColVal::Int(now),
            )?;
        }
        "thread.dismiss" => {
            store.update_thread_field(
                &object,
                crate::store::ThreadCol::SettledAt,
                crate::store::ColVal::Null,
            )?;
        }
        other => return Err(format!("NOT_UNDOABLE: no undo is written for {other}")),
    }
    store.mark_orchestrator_action_undone(action_id, now)?;
    let project = store.project_of_thread(&object).ok();
    let seq = store.append_moment(
        "orchestrator.undone",
        project.as_deref(),
        Some(action_id),
        &kind,
        "orchestrator",
        now,
    )?;
    if let Some(waiters) = waiters {
        waiters.notify();
    }
    Ok(json!({ "done": true, "seq": seq }))
}

/// Puts a finished worker away on the orchestrator's word. Route-only: the
/// dismissal is `thread.settle`'s write behind the same busy rule
/// (`crate::settle::can_settle`), gated on the caller's role.
pub fn dismiss(
    store: &Store,
    waiters: Option<&Arc<Waiters>>,
    thread_id: &str,
    to_thread_id: &str,
) -> Result<Value, String> {
    let target_project = conducted_target(store, thread_id, to_thread_id)?;
    // The recorded status is the best either host holds here, and it is the
    // same column the persistence task writes on every transition.
    let status = store
        .thread_status(to_thread_id)
        .map(|(status, _)| status)
        .unwrap_or_else(|| "idle".to_string());
    if !crate::settle::can_settle(&status) {
        return Err(crate::settle::refusal(&status));
    }
    let now = crate::now_ms();
    store.update_thread_field(
        to_thread_id,
        crate::store::ThreadCol::SettledAt,
        crate::store::ColVal::Int(now),
    )?;
    let seq = store.append_moment(
        "thread.dismissed",
        Some(&target_project),
        Some(to_thread_id),
        "",
        "dispatch",
        now,
    )?;
    if let Some(waiters) = waiters {
        waiters.notify();
    }
    Ok(json!({ "threadId": to_thread_id, "seq": seq }))
}

#[derive(Debug, Clone)]
pub enum Conduct {
    /// The workspace since a cursor, with an optional wait when it is quiet.
    Pulse {
        since_seq: i64,
        timeout_ms: u64,
        project: Option<String>,
        /// Who is waiting, for the one-wait-per-caller rule. The transports
        /// pass the calling thread's id; the window passes its own name.
        waiter: String,
    },
    /// One moment appended to the ring. This is how a device writes a worker's
    /// phase transition down, and how anything else worth a wake gets one.
    Record {
        kind: String,
        project_id: Option<String>,
        object_id: Option<String>,
        detail: String,
        source: String,
    },
    /// A user line into the orchestrator conversation.
    Post {
        scope: Option<String>,
        text: String,
    },
    /// The orchestrator's line back. Refused unless the named thread carries
    /// the orchestrator role — the row is the proof, not the caller's word.
    Say {
        thread_id: String,
        text: String,
        aloud: Option<String>,
        urgency: Option<String>,
    },
    /// One scope's conversation, oldest first, after a cursor.
    Messages {
        scope: Option<String>,
        since_id: Option<String>,
        limit: usize,
    },
    /// Stamps the orchestrator role onto a thread the window just opened.
    ///
    /// The one write the records barrier points at, and the one method in this
    /// domain only `Grant::Local` reaches: a role is the user arming something,
    /// never an agent promoting itself.
    Start {
        thread_id: String,
        scope: Option<String>,
    },
    /// Which thread is the live orchestrator for a scope, if any.
    Status { scope: Option<String> },
    /// What the orchestrators caused, newest first, for the inbox's undo list.
    Actions { limit: usize },
    /// Un-does one recorded action. Local only: undoing is the user taking
    /// something back, never an agent covering its tracks.
    Undo { action_id: String },
    /// One line queued for another thread's prompt. The static guards live
    /// here (role, mute, scope); the live ones (phase, permission on screen)
    /// belong to the device at flush time.
    Dispatch {
        /// Who asks. The row is the proof: only an orchestrator dispatches.
        thread_id: String,
        to_thread_id: String,
        text: String,
        mode: String,
    },
    /// The user's mute switch for one thread. Local only: an agent never
    /// rearms a thread the user muted, and muting drops the thread's backlog.
    AcceptDispatch { thread_id: String, accept: bool },
    /// Everything still queued, oldest first, with the TTL sweep applied
    /// first. What a device reads before it types anything.
    Drain { ttl_ms: u32 },
    /// The device's report on one line: `delivered`, `dropped` or `refused`,
    /// with the guard's named reason. How the orchestrator learns the outcome
    /// without polling — the settle is also a moment.
    SettleDispatch {
        dispatch_id: String,
        state: String,
        reason: Option<String>,
    },
    /// One recorded utterance turned into text by the desktop's own
    /// whisper.cpp (`crate::voice`). A bounded body on the ordinary bus, never
    /// a stream: this is how a paired phone without a speech engine borrows
    /// the machine that has one.
    Transcribe {
        audio: String,
        mime: String,
        provider: String,
    },
}

impl Conduct {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        Ok(match method {
            "conduct.pulse" => Conduct::Pulse {
                since_seq: params
                    .get("sinceSeq")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                timeout_ms: params
                    .get("timeoutMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(pulse::DEFAULT_TIMEOUT_MS)
                    .min(pulse::MAX_TIMEOUT_MS),
                project: opt_str_param(params, "project"),
                waiter: opt_str_param(params, "waiter").unwrap_or_else(|| "local".to_string()),
            },
            "conduct.record" => Conduct::Record {
                kind: str_param(params, "kind")?,
                project_id: opt_str_param(params, "projectId"),
                object_id: opt_str_param(params, "objectId"),
                detail: opt_str_param(params, "detail").unwrap_or_default(),
                source: opt_str_param(params, "source").unwrap_or_else(|| "phase".to_string()),
            },
            "orchestrator.post" => Conduct::Post {
                scope: opt_str_param(params, "scope"),
                text: str_param(params, "text")?,
            },
            "orchestrator.say" => Conduct::Say {
                thread_id: str_param(params, "threadId")?,
                text: str_param(params, "text")?,
                aloud: opt_str_param(params, "aloud"),
                urgency: opt_str_param(params, "urgency"),
            },
            "orchestrator.messages" => Conduct::Messages {
                scope: opt_str_param(params, "scope"),
                since_id: opt_str_param(params, "sinceId"),
                limit: u32_param(params, "limit", MESSAGES_LIMIT_DEFAULT)
                    .clamp(1, MESSAGES_LIMIT_MAX) as usize,
            },
            "orchestrator.start" => Conduct::Start {
                thread_id: str_param(params, "threadId")?,
                scope: opt_str_param(params, "scope"),
            },
            "orchestrator.actions" => Conduct::Actions {
                limit: u32_param(params, "limit", ACTIONS_LIMIT_DEFAULT).clamp(1, ACTIONS_LIMIT_MAX)
                    as usize,
            },
            "orchestrator.undo" => Conduct::Undo {
                action_id: str_param(params, "actionId")?,
            },
            "orchestrator.status" => Conduct::Status {
                scope: opt_str_param(params, "scope"),
            },
            "thread.dispatch" => Conduct::Dispatch {
                thread_id: str_param(params, "threadId")?,
                to_thread_id: str_param(params, "toThreadId")?,
                text: str_param(params, "text")?,
                mode: opt_str_param(params, "mode").unwrap_or_else(|| "queue".to_string()),
            },
            "thread.acceptDispatch" => Conduct::AcceptDispatch {
                thread_id: str_param(params, "threadId")?,
                accept: super::bool_param(params, "accept", true),
            },
            "dispatch.drain" => Conduct::Drain {
                ttl_ms: u32_param(params, "ttlMs", DISPATCH_TTL_MS_DEFAULT),
            },
            "dispatch.settle" => Conduct::SettleDispatch {
                dispatch_id: str_param(params, "dispatchId")?,
                state: str_param(params, "state")?,
                reason: opt_str_param(params, "reason"),
            },
            "voice.transcribe" => Conduct::Transcribe {
                audio: str_param(params, "audio")?,
                mime: opt_str_param(params, "mime").unwrap_or_else(|| "audio/wav".to_string()),
                provider: opt_str_param(params, "provider")
                    .unwrap_or_else(|| crate::voice::PROVIDER_WHISPER_LOCAL.to_string()),
            },
            other => return Err(format!("unknown method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Conduct::Pulse { .. } => "conduct.pulse",
            Conduct::Record { .. } => "conduct.record",
            Conduct::Post { .. } => "orchestrator.post",
            Conduct::Say { .. } => "orchestrator.say",
            Conduct::Messages { .. } => "orchestrator.messages",
            Conduct::Start { .. } => "orchestrator.start",
            Conduct::Status { .. } => "orchestrator.status",
            Conduct::Actions { .. } => "orchestrator.actions",
            Conduct::Undo { .. } => "orchestrator.undo",
            Conduct::Dispatch { .. } => "thread.dispatch",
            Conduct::AcceptDispatch { .. } => "thread.acceptDispatch",
            Conduct::Drain { .. } => "dispatch.drain",
            Conduct::SettleDispatch { .. } => "dispatch.settle",
            Conduct::Transcribe { .. } => "voice.transcribe",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            // Both carry several named halves already.
            Conduct::Pulse { .. } => Wire::Bare,
            Conduct::Record { .. } => Wire::Bare,
            Conduct::Post { .. } | Conduct::Say { .. } => Wire::Bare,
            Conduct::Messages { .. } => Wire::Key("messages"),
            Conduct::Start { .. } | Conduct::Status { .. } => Wire::Bare,
            Conduct::Actions { .. } => Wire::Key("actions"),
            Conduct::Undo { .. } => Wire::Bare,
            Conduct::Drain { .. } => Wire::Key("dispatches"),
            Conduct::Dispatch { .. }
            | Conduct::AcceptDispatch { .. }
            | Conduct::SettleDispatch { .. } => Wire::Bare,
            Conduct::Transcribe { .. } => Wire::Key("text"),
        }
    }

    pub(super) fn capability(&self) -> Capability {
        match self {
            // Transcribe reads nothing from the store, but it does spend the
            // desktop's CPU on the caller's behalf: ReadProject keeps it off
            // an unpaired key without pretending it mutates anything.
            Conduct::Pulse { .. }
            | Conduct::Messages { .. }
            | Conduct::Status { .. }
            | Conduct::Actions { .. }
            | Conduct::Transcribe { .. } => Capability::ReadProject,
            Conduct::Record { .. }
            | Conduct::Post { .. }
            | Conduct::Say { .. }
            | Conduct::Start { .. }
            | Conduct::Undo { .. }
            | Conduct::Dispatch { .. }
            | Conduct::AcceptDispatch { .. }
            | Conduct::Drain { .. }
            | Conduct::SettleDispatch { .. } => Capability::MutateProject,
        }
    }

    pub(super) fn prepare(self, host: &dyn Host, grant: Grant) -> Result<Ready, String> {
        // Not a capability: `Grant::Conduct` holds MutateProject too, and an
        // orchestrator stamping a second orchestrator is exactly the promotion
        // this refuses. The role is armed from the user's own window or not at
        // all.
        if matches!(self, Conduct::Start { .. }) && grant != Grant::Local {
            return Err(
                "only Boite's own window arms an orchestrator; an agent cannot stamp the role"
                    .to_string(),
            );
        }
        // Same refusal for the undo: taking an action back is the user's,
        // and an agent that could undo would be an agent covering its tracks.
        if matches!(self, Conduct::Undo { .. }) && grant != Grant::Local {
            return Err(
                "only Boite's own window undoes an orchestrator action; an agent cannot"
                    .to_string(),
            );
        }
        // Same shape for the queue's device half: draining, settling and the
        // mute switch belong to the thing that owns the PTY and to the user.
        // An agent that could rearm `accept_dispatch` would undo the user's
        // own mute, which is the promotion this refuses.
        if matches!(
            self,
            Conduct::AcceptDispatch { .. } | Conduct::Drain { .. } | Conduct::SettleDispatch { .. }
        ) && grant != Grant::Local
        {
            return Err(
                "only a device drains, settles or mutes dispatches; an agent never touches \
                 the queue's device half"
                    .to_string(),
            );
        }
        let store = host
            .store()
            .ok_or("this Boite keeps no records, so there is no pulse to read or write")?;
        Ok(Ready::Conduct(self, store, host.pulse_waiters()))
    }

    pub(super) fn run(
        self,
        store: &Store,
        waiters: Option<Arc<Waiters>>,
    ) -> Result<Value, String> {
        Ok(match self {
            Conduct::Pulse {
                since_seq,
                timeout_ms,
                project,
                waiter,
            } => read_pulse(
                store,
                waiters.as_ref(),
                since_seq,
                timeout_ms,
                project.as_deref(),
                &waiter,
            )?,
            Conduct::Record {
                kind,
                project_id,
                object_id,
                detail,
                source,
            } => {
                let seq = store.append_moment(
                    &kind,
                    project_id.as_deref(),
                    object_id.as_deref(),
                    &detail,
                    &source,
                    crate::now_ms(),
                )?;
                if let Some(waiters) = waiters {
                    waiters.notify();
                }
                json!({ "seq": seq })
            }
            Conduct::Post { scope, text } => {
                let id = store.add_orchestrator_message(
                    scope.as_deref(),
                    "user",
                    &text,
                    None,
                    None,
                    crate::now_ms(),
                )?;
                // The user spoke: also a moment, because a sleeping
                // orchestrator's only ear is the pulse it long-polls.
                let seq = store.append_moment(
                    "chat.posted",
                    scope.as_deref(),
                    Some(&id),
                    "",
                    "chat",
                    crate::now_ms(),
                )?;
                if let Some(waiters) = waiters {
                    waiters.notify();
                }
                json!({ "messageId": id, "seq": seq })
            }
            Conduct::Say {
                thread_id,
                text,
                aloud,
                urgency,
            } => say(
                store,
                waiters.as_ref(),
                &thread_id,
                &text,
                aloud.as_deref(),
                urgency.as_deref(),
            )?,
            Conduct::Messages {
                scope,
                since_id,
                limit,
            } => value_of(store.orchestrator_messages(
                scope.as_deref(),
                since_id.as_deref(),
                limit,
            )?),
            Conduct::Start { thread_id, scope } => {
                store
                    .thread_orchestration(&thread_id)
                    .ok_or("unknown thread")?;
                // One live holder per scope. The settled check is inside
                // `find_orchestrator`: a stamp on a closed row does not block
                // the next start.
                if let Some(holder) = store.find_orchestrator(scope.as_deref()) {
                    if holder != thread_id {
                        return Err(format!(
                            "ORCHESTRATOR_TAKEN: thread {holder} is already the live \
                             orchestrator for this scope"
                        ));
                    }
                }
                store.stamp_orchestrator_role(&thread_id, scope.as_deref())?;
                // The queue changes hands with the scope: what the global
                // orchestrator queued into this project settles as refused,
                // or a line queued under the old owner lands under the new
                // one's watch. Each settle is a moment, so the old owner
                // learns without polling.
                if let Some(project) = scope.as_deref() {
                    let now = crate::now_ms();
                    for id in store.settle_dispatches_into_project(
                        project,
                        &thread_id,
                        crate::orchestrator::dispatch::STATE_REFUSED,
                        "SCOPE_TAKEN",
                        now,
                    )? {
                        store.append_moment(
                            "dispatch.settled",
                            Some(project),
                            Some(&id),
                            "refused:SCOPE_TAKEN",
                            "dispatch",
                            now,
                        )?;
                    }
                }
                let seq = store.append_moment(
                    "orchestrator.started",
                    scope.as_deref(),
                    Some(&thread_id),
                    "",
                    "orchestrator",
                    crate::now_ms(),
                )?;
                if let Some(waiters) = waiters {
                    waiters.notify();
                }
                json!({ "threadId": thread_id, "seq": seq })
            }
            Conduct::Status { scope } => match store.find_orchestrator(scope.as_deref()) {
                Some(id) => json!({ "threadId": id, "state": "live" }),
                None => json!({ "threadId": null, "state": "off" }),
            },
            Conduct::Actions { limit } => value_of(store.orchestrator_actions(limit)?),
            Conduct::Undo { action_id } => undo(store, waiters.as_ref(), &action_id)?,
            Conduct::Dispatch {
                thread_id,
                to_thread_id,
                text,
                mode,
            } => dispatch(
                store,
                waiters.as_ref(),
                &thread_id,
                &to_thread_id,
                &text,
                &mode,
            )?,
            Conduct::AcceptDispatch { thread_id, accept } => {
                store
                    .thread_orchestration(&thread_id)
                    .ok_or("unknown thread")?;
                store.set_accept_dispatch(&thread_id, accept)?;
                let now = crate::now_ms();
                let mut dropped = 0;
                if !accept {
                    // Muting empties the backlog too: a mute that lets queued
                    // lines land later is not a mute. Each drop is a moment,
                    // so the orchestrator learns without polling.
                    let project = store.project_of_thread(&thread_id).ok();
                    for id in store.settle_dispatches_to(
                        &thread_id,
                        crate::orchestrator::dispatch::STATE_DROPPED,
                        "muted",
                        now,
                    )? {
                        store.append_moment(
                            "dispatch.settled",
                            project.as_deref(),
                            Some(&id),
                            "dropped:muted",
                            "dispatch",
                            now,
                        )?;
                        dropped += 1;
                    }
                }
                if let Some(waiters) = waiters {
                    waiters.notify();
                }
                json!({ "threadId": thread_id, "accept": accept, "dropped": dropped })
            }
            Conduct::Drain { ttl_ms } => {
                let now = crate::now_ms();
                let expired = store.expire_dispatches(now - i64::from(ttl_ms), now)?;
                for id in &expired {
                    store.append_moment(
                        "dispatch.settled",
                        None,
                        Some(id),
                        "dropped:no_device",
                        "dispatch",
                        now,
                    )?;
                }
                if !expired.is_empty() {
                    if let Some(waiters) = waiters {
                        waiters.notify();
                    }
                }
                value_of(store.open_dispatches()?)
            }
            Conduct::SettleDispatch {
                dispatch_id,
                state,
                reason,
            } => {
                if !SETTLE_STATES.contains(&state.as_str()) {
                    return Err(format!(
                        "unknown settle state {state}; it is one of delivered, dropped, refused"
                    ));
                }
                let now = crate::now_ms();
                match store.settle_dispatch(&dispatch_id, &state, reason.as_deref(), now)? {
                    Some((_, to_thread_id)) => {
                        let project = store.project_of_thread(&to_thread_id).ok();
                        let detail = match &reason {
                            Some(reason) => format!("{state}:{reason}"),
                            None => state.clone(),
                        };
                        let seq = store.append_moment(
                            "dispatch.settled",
                            project.as_deref(),
                            Some(&dispatch_id),
                            &detail,
                            "dispatch",
                            now,
                        )?;
                        if let Some(waiters) = waiters {
                            waiters.notify();
                        }
                        json!({ "dispatchId": dispatch_id, "settled": true, "seq": seq })
                    }
                    // Already settled, most often by the TTL sweep racing this
                    // report. The first writer's reason stands.
                    None => json!({ "dispatchId": dispatch_id, "settled": false }),
                }
            }
            Conduct::Transcribe {
                audio,
                mime,
                provider,
            } => json!(crate::voice::transcribe(&audio, &mime, &provider)?),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Grant;
    use crate::command::{Command, Host};
    use crate::scope::ProjectRoots;

    struct Rows {
        roots: ProjectRoots,
        store: Arc<Store>,
        waiters: Option<Arc<Waiters>>,
    }

    impl Rows {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "boite-conduct-{}-{name}.db",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&path);
            Rows {
                roots: ProjectRoots::default(),
                store: Arc::new(Store::open(&path).unwrap()),
                waiters: None,
            }
        }
    }

    impl Host for Rows {
        fn roots(&self) -> &ProjectRoots {
            &self.roots
        }
        fn store(&self) -> Option<Arc<Store>> {
            Some(self.store.clone())
        }
        fn pulse_waiters(&self) -> Option<Arc<Waiters>> {
            self.waiters.clone()
        }
    }

    fn ask(host: &Rows, method: &str, params: Value) -> Result<Value, String> {
        Command::decode(method, &params)?
            .prepare(host, Grant::Local)?
            .run()
    }

    #[test]
    fn a_moment_recorded_is_a_moment_read_back_with_its_cursor() {
        let host = Rows::new("roundtrip");
        let first = ask(
            &host,
            "conduct.record",
            json!({ "kind": "thread.phase", "projectId": "p1", "objectId": "t1",
                    "detail": "running", "source": "phase" }),
        )
        .unwrap();
        let seq = first["seq"].as_i64().unwrap();
        assert!(seq > 0);

        let pulse = ask(&host, "conduct.pulse", json!({ "sinceSeq": 0, "timeoutMs": 0 })).unwrap();
        assert_eq!(pulse["moments"].as_array().unwrap().len(), 1);
        assert_eq!(pulse["moments"][0]["kind"], json!("thread.phase"));
        assert_eq!(pulse["seq"], json!(seq));
        assert_eq!(pulse["truncated"], json!(false));

        // Reading from the cursor is empty, and a zero timeout answers now.
        let quiet =
            ask(&host, "conduct.pulse", json!({ "sinceSeq": seq, "timeoutMs": 0 })).unwrap();
        assert!(quiet["moments"].as_array().unwrap().is_empty());
        assert_eq!(quiet["seq"], json!(seq), "the cursor holds through a quiet read");
    }

    /// A sleeper that outslept the ring is told so, rather than being handed an
    /// empty list that reads as "nothing happened".
    #[test]
    fn a_cursor_that_fell_out_of_the_ring_is_named_truncated() {
        let host = Rows::new("truncated");
        for i in 0..(pulse::RING_CAP + 10) {
            host.store
                .append_moment("thread.phase", None, None, &format!("{i}"), "phase", i)
                .unwrap();
        }
        let pulse = ask(&host, "conduct.pulse", json!({ "sinceSeq": 1, "timeoutMs": 0 })).unwrap();
        assert_eq!(pulse["truncated"], json!(true));
    }

    /// Only a thread the row says is an orchestrator may speak as one.
    #[test]
    fn say_is_refused_to_a_thread_without_the_role() {
        let host = Rows::new("say");
        let row = |id: &str| {
            json!({ "thread": { "id": id, "projectId": "p", "label": "l", "cmd": "c", "args": [] } })
        };
        ask(&host, "thread.create", row("worker")).unwrap();
        ask(&host, "thread.create", row("boss")).unwrap();
        host.store.stamp_orchestrator_role("boss", None).unwrap();

        let refusal = ask(
            &host,
            "orchestrator.say",
            json!({ "threadId": "worker", "text": "hello" }),
        )
        .unwrap_err();
        assert!(refusal.contains("not one"), "{refusal}");

        ask(
            &host,
            "orchestrator.say",
            json!({ "threadId": "boss", "text": "hello", "aloud": "hi", "urgency": "answer" }),
        )
        .unwrap();
        ask(&host, "orchestrator.post", json!({ "text": "user line" })).unwrap();

        // Both lines land; the two can share a millisecond, so they are found
        // by role rather than by position.
        let messages = ask(&host, "orchestrator.messages", json!({})).unwrap();
        let list = messages.as_array().unwrap().clone();
        assert_eq!(list.len(), 2);
        let said = list
            .iter()
            .find(|m| m["role"] == json!("orchestrator"))
            .expect("the orchestrator line landed");
        assert_eq!(said["aloud"], json!("hi"));
        assert!(list.iter().any(|m| m["role"] == json!("user")));
    }

    /// The chat reads by cursor, and the cursor is an id from a previous read.
    #[test]
    fn messages_read_after_a_cursor_id() {
        let host = Rows::new("cursor");
        let a = host
            .store
            .add_orchestrator_message(None, "user", "first", None, None, 1)
            .unwrap();
        host.store
            .add_orchestrator_message(None, "user", "second", None, None, 2)
            .unwrap();
        let after = ask(&host, "orchestrator.messages", json!({ "sinceId": a })).unwrap();
        let list = after.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["text"], json!("second"));
    }

    /// Arming is the user's gesture: no agent grant reaches it, one live
    /// holder per scope, and asking again for the same thread is idempotent.
    #[test]
    fn start_is_local_only_and_one_holder_per_scope() {
        let host = Rows::new("start");
        let row = |id: &str| {
            json!({ "thread": { "id": id, "projectId": "p", "label": "l", "cmd": "c", "args": [] } })
        };
        ask(&host, "thread.create", row("a")).unwrap();
        ask(&host, "thread.create", row("b")).unwrap();

        let refusal = Command::decode("orchestrator.start", &json!({ "threadId": "a" }))
            .unwrap()
            .prepare(&host, Grant::Conduct)
            .unwrap_err();
        assert!(refusal.contains("arms an orchestrator"), "{refusal}");

        ask(&host, "orchestrator.start", json!({ "threadId": "a" })).unwrap();
        let taken = ask(&host, "orchestrator.start", json!({ "threadId": "b" })).unwrap_err();
        assert!(taken.contains("ORCHESTRATOR_TAKEN"), "{taken}");
        // The same thread asking again is a restart, not a conflict.
        ask(&host, "orchestrator.start", json!({ "threadId": "a" })).unwrap();

        let status = ask(&host, "orchestrator.status", json!({})).unwrap();
        assert_eq!(status["threadId"], json!("a"));
        assert_eq!(status["state"], json!("live"));

        // A settled holder releases the scope.
        ask(
            &host,
            "thread.settle",
            json!({ "threadId": "a", "status": "idle", "settled": true }),
        )
        .unwrap();
        ask(&host, "orchestrator.start", json!({ "threadId": "b" })).unwrap();
    }

    /// An undo is the user's, stamped once: a dismissal comes back, asking
    /// again is refused by name, and no agent grant reaches it at all.
    #[test]
    fn undo_brings_a_dismissed_thread_back_and_refuses_twice() {
        let host = Rows::new("undo");
        let row = |id: &str| {
            json!({ "thread": { "id": id, "projectId": "p", "label": "l", "cmd": "c", "args": [] } })
        };
        ask(&host, "thread.create", row("boss")).unwrap();
        ask(&host, "thread.create", row("worker")).unwrap();
        host.store.stamp_orchestrator_role("boss", None).unwrap();
        // The worker was put away, and the route wrote it down.
        host.store
            .update_thread_field(
                "worker",
                crate::store::ThreadCol::SettledAt,
                crate::store::ColVal::Int(5),
            )
            .unwrap();
        let action = host
            .store
            .record_orchestrator_action("boss", "thread.dismiss", Some("worker"), Some("p"), true, 5)
            .unwrap();

        let refusal = Command::decode("orchestrator.undo", &json!({ "actionId": action }))
            .unwrap()
            .prepare(&host, Grant::Conduct)
            .unwrap_err();
        assert!(refusal.contains("undoes"), "{refusal}");

        let listed = ask(&host, "orchestrator.actions", json!({})).unwrap();
        assert_eq!(listed[0]["undoable"], json!(true));

        let done = ask(&host, "orchestrator.undo", json!({ "actionId": action })).unwrap();
        assert_eq!(done["done"], json!(true));
        // The thread is back out, and the action stops being offered.
        let worker = host.store.load_thread("worker").unwrap().unwrap();
        assert_eq!(worker.settled_at, None);
        let again = ask(&host, "orchestrator.undo", json!({ "actionId": action })).unwrap_err();
        assert!(again.contains("ALREADY_UNDONE"), "{again}");
        let listed = ask(&host, "orchestrator.actions", json!({})).unwrap();
        assert!(listed[0]["undoneAt"].is_i64());
    }

    /// Arming a project orchestrator empties the global one's backlog into
    /// that project: the queue changed hands, and the old owner's queued
    /// lines settle as refused rather than landing under the new watch.
    #[test]
    fn a_scoped_start_settles_the_global_backlog_into_its_project() {
        let host = Rows::new("takeover");
        let row = |id: &str, project: &str| {
            json!({ "thread": { "id": id, "projectId": project, "label": "l", "cmd": "c", "args": [] } })
        };
        ask(&host, "thread.create", row("boss", "hub")).unwrap();
        ask(&host, "thread.create", row("worker", "q")).unwrap();
        ask(&host, "thread.create", row("qboss", "q")).unwrap();
        ask(&host, "orchestrator.start", json!({ "threadId": "boss" })).unwrap();
        let queued = ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "boss", "toThreadId": "worker", "text": "line" }),
        )
        .unwrap();
        let dispatch_id = queued["dispatchId"].as_str().unwrap().to_string();

        ask(
            &host,
            "orchestrator.start",
            json!({ "threadId": "qboss", "scope": "q" }),
        )
        .unwrap();

        // The line never reaches a drain: it settled at the takeover.
        let open = ask(&host, "dispatch.drain", json!({})).unwrap();
        assert!(open.as_array().unwrap().is_empty(), "{open}");
        // And the takeover's word stands: first writer wins.
        let again = ask(
            &host,
            "dispatch.settle",
            json!({ "dispatchId": dispatch_id, "state": "delivered" }),
        )
        .unwrap();
        assert_eq!(again["settled"], json!(false));
    }

    /// The wait wakes on a record and never holds past its cap. The transport
    /// half of the long-poll; the registry's own rules are tested in
    /// `crate::pulse`.
    #[test]
    fn a_pulse_wait_is_woken_by_a_record() {
        let mut host = Rows::new("wait");
        host.waiters = Some(Waiters::new());
        let store = host.store.clone();
        let waiters = host.waiters.clone().unwrap();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            store
                .append_moment("thread.phase", None, None, "ready", "phase", 1)
                .unwrap();
            waiters.notify();
        });
        let pulse = ask(
            &host,
            "conduct.pulse",
            json!({ "sinceSeq": 0, "timeoutMs": 5000, "waiter": "test" }),
        )
        .unwrap();
        writer.join().unwrap();
        assert_eq!(pulse["timedOut"], json!(false));
        assert_eq!(pulse["moments"].as_array().unwrap().len(), 1);
    }

    fn thread_row(id: &str, project: &str) -> Value {
        json!({ "thread": { "id": id, "projectId": project, "label": "l", "cmd": "c", "args": [] } })
    }

    /// A host with a stamped global orchestrator and one plain worker, the
    /// starting shape of every dispatch test.
    fn dispatch_host(name: &str) -> Rows {
        let host = Rows::new(name);
        ask(&host, "thread.create", thread_row("boss", "p")).unwrap();
        ask(&host, "thread.create", thread_row("worker", "p")).unwrap();
        host.store.stamp_orchestrator_role("boss", None).unwrap();
        host
    }

    /// The row is the proof: a worker asking to dispatch is refused by role,
    /// and static target guards refuse at queue time with the same names the
    /// device would use at flush time.
    #[test]
    fn dispatch_is_refused_by_role_and_static_target_guards() {
        let host = dispatch_host("guards");
        ask(&host, "thread.create", thread_row("peer", "p")).unwrap();

        let no_role = ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "worker", "toThreadId": "peer", "text": "hi" }),
        )
        .unwrap_err();
        assert!(no_role.contains("not one"), "{no_role}");

        // Both directions: the boss into another orchestrator is refused too.
        host.store.stamp_orchestrator_role("peer", Some("q")).unwrap();
        let to_peer = ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "boss", "toThreadId": "peer", "text": "hi" }),
        )
        .unwrap_err();
        assert!(to_peer.contains("NO_ORCHESTRATOR_TO_ORCHESTRATOR"), "{to_peer}");

        ask(
            &host,
            "thread.acceptDispatch",
            json!({ "threadId": "worker", "accept": false }),
        )
        .unwrap();
        let muted = ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "boss", "toThreadId": "worker", "text": "hi" }),
        )
        .unwrap_err();
        assert!(muted.contains("MUTED"), "{muted}");
    }

    /// A global orchestrator stays out of a project that has its own, and a
    /// project orchestrator stays inside its own project.
    #[test]
    fn dispatch_scope_is_owned_by_the_nearest_orchestrator() {
        let host = dispatch_host("scope");
        ask(&host, "thread.create", thread_row("qworker", "q")).unwrap();
        ask(&host, "thread.create", thread_row("qboss", "q")).unwrap();
        host.store.stamp_orchestrator_role("qboss", Some("q")).unwrap();

        let taken = ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "boss", "toThreadId": "qworker", "text": "hi" }),
        )
        .unwrap_err();
        assert!(taken.contains("SCOPE_TAKEN"), "{taken}");

        let out = ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "qboss", "toThreadId": "worker", "text": "hi" }),
        )
        .unwrap_err();
        assert!(out.contains("OUT_OF_SCOPE"), "{out}");

        // Inside its own project the line queues.
        ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "qboss", "toThreadId": "qworker", "text": "hi" }),
        )
        .unwrap();
    }

    /// The queue roundtrip: queued, read by the drain, settled once. The
    /// second settle loses the race and says so rather than rewriting history.
    #[test]
    fn a_dispatch_queues_drains_and_settles_once() {
        let host = dispatch_host("queue-roundtrip");
        let queued = ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "boss", "toThreadId": "worker", "text": "run tests", "mode": "now" }),
        )
        .unwrap();
        let id = queued["dispatchId"].as_str().unwrap().to_string();

        let open = ask(&host, "dispatch.drain", json!({})).unwrap();
        let list = open.as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], json!(id.clone()));
        assert_eq!(list[0]["toThreadId"], json!("worker"));
        assert_eq!(list[0]["mode"], json!("now"));

        let bad = ask(
            &host,
            "dispatch.settle",
            json!({ "dispatchId": id.clone(), "state": "typed" }),
        )
        .unwrap_err();
        assert!(bad.contains("unknown settle state"), "{bad}");

        let first = ask(
            &host,
            "dispatch.settle",
            json!({ "dispatchId": id.clone(), "state": "delivered" }),
        )
        .unwrap();
        assert_eq!(first["settled"], json!(true));
        let again = ask(
            &host,
            "dispatch.settle",
            json!({ "dispatchId": id.clone(), "state": "refused", "reason": "TARGET_BUSY" }),
        )
        .unwrap();
        assert_eq!(again["settled"], json!(false), "the first writer's word stands");

        let drained = ask(&host, "dispatch.drain", json!({})).unwrap();
        assert!(drained.as_array().unwrap().is_empty());
    }

    /// Muting a thread drops its backlog: a mute that lets queued lines land
    /// later is not a mute.
    #[test]
    fn muting_drops_the_backlog() {
        let host = dispatch_host("mute");
        ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "boss", "toThreadId": "worker", "text": "one" }),
        )
        .unwrap();
        ask(
            &host,
            "thread.dispatch",
            json!({ "threadId": "boss", "toThreadId": "worker", "text": "two" }),
        )
        .unwrap();
        let muted = ask(
            &host,
            "thread.acceptDispatch",
            json!({ "threadId": "worker", "accept": false }),
        )
        .unwrap();
        assert_eq!(muted["dropped"], json!(2));
        let open = ask(&host, "dispatch.drain", json!({})).unwrap();
        assert!(open.as_array().unwrap().is_empty());
    }

    /// A line older than the TTL is swept by the drain before anything reads
    /// it, settled `dropped` with the reason the orchestrator can act on.
    #[test]
    fn the_drain_sweeps_expired_lines_first() {
        let host = dispatch_host("ttl");
        // Backdated through the store: the bus stamps its own clock.
        host.store
            .queue_dispatch("boss", "worker", "stale", "queue", 1)
            .unwrap();
        let open = ask(&host, "dispatch.drain", json!({ "ttlMs": 1000 })).unwrap();
        assert!(open.as_array().unwrap().is_empty());
        let pulse = ask(&host, "conduct.pulse", json!({ "sinceSeq": 0, "timeoutMs": 0 })).unwrap();
        let settled = pulse["moments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["kind"] == json!("dispatch.settled"))
            .expect("the sweep is a moment");
        assert_eq!(settled["detail"], json!("dropped:no_device"));
    }

    /// The queue's device half is the device's and the user's, never an
    /// agent's: an agent that could drain, settle or rearm a mute would be
    /// typing with the user's hands.
    #[test]
    fn the_device_half_is_local_only() {
        let host = dispatch_host("local");
        for (method, params) in [
            ("thread.acceptDispatch", json!({ "threadId": "worker" })),
            ("dispatch.drain", json!({})),
            (
                "dispatch.settle",
                json!({ "dispatchId": "d", "state": "delivered" }),
            ),
        ] {
            let refusal = Command::decode(method, &params)
                .unwrap()
                .prepare(&host, Grant::Conduct)
                .unwrap_err();
            assert!(refusal.contains("device half"), "{method}: {refusal}");
        }
        // Dispatch itself is the agent's verb: the conduct grant reaches it.
        Command::decode(
            "thread.dispatch",
            &json!({ "threadId": "boss", "toThreadId": "worker", "text": "hi" }),
        )
        .unwrap()
        .prepare(&host, Grant::Conduct)
        .unwrap();
    }
}
