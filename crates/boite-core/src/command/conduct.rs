//! The orchestration surface: the pulse, and the orchestrator conversation.
//!
//! Small on purpose, and grown phase by phase: dispatch joins later, behind its
//! own review. What is here is what phase 1 needs — a worker's phase
//! transitions written down (`conduct.record`), read back with an optional wait
//! (`conduct.pulse`), and the durable chat the user and the orchestrator share
//! (`orchestrator.post` / `orchestrator.say` / `orchestrator.messages`).
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
use crate::capability::Capability;
use crate::pulse::{self, Waiters};
use crate::store::Store;

/// Every method in this domain, in the order they appear below.
pub const ALL_METHODS: &[&str] = &[
    "conduct.pulse",
    "conduct.record",
    "orchestrator.post",
    "orchestrator.say",
    "orchestrator.messages",
];

/// How many moments one pulse answer carries at most.
const PULSE_LIMIT: usize = 500;

/// How many chat lines one read answers with when the caller says nothing.
const MESSAGES_LIMIT_DEFAULT: u32 = 50;
const MESSAGES_LIMIT_MAX: u32 = 500;

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
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            // Both carry several named halves already.
            Conduct::Pulse { .. } => Wire::Bare,
            Conduct::Record { .. } => Wire::Bare,
            Conduct::Post { .. } | Conduct::Say { .. } => Wire::Bare,
            Conduct::Messages { .. } => Wire::Key("messages"),
        }
    }

    pub(super) fn capability(&self) -> Capability {
        match self {
            Conduct::Pulse { .. } | Conduct::Messages { .. } => Capability::ReadProject,
            Conduct::Record { .. } | Conduct::Post { .. } | Conduct::Say { .. } => {
                Capability::MutateProject
            }
        }
    }

    pub(super) fn prepare(self, host: &dyn Host) -> Result<Ready, String> {
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
            } => {
                let (mut moments, mut truncated) =
                    store.read_moments(since_seq, PULSE_LIMIT, project.as_deref())?;
                let mut timed_out = false;
                if moments.is_empty() {
                    match waiters {
                        Some(waiters) if timeout_ms > 0 => {
                            match waiters.wait(&waiter, timeout_ms)? {
                                pulse::Outcome::Woken => {
                                    let again = store.read_moments(
                                        since_seq,
                                        PULSE_LIMIT,
                                        project.as_deref(),
                                    )?;
                                    moments = again.0;
                                    truncated = again.1;
                                }
                                pulse::Outcome::TimedOut => timed_out = true,
                                pulse::Outcome::Superseded => {
                                    // The agent doubled itself. A named error,
                                    // never a lying timeout.
                                    return Err(
                                        "PULSE_SUPERSEDED: a newer pulse from the same caller \
                                         replaced this one"
                                            .to_string(),
                                    );
                                }
                            }
                        }
                        // No waiter registry on this host, or a zero timeout:
                        // an empty answer now is the honest one.
                        _ => timed_out = timeout_ms > 0,
                    }
                }
                let seq = moments
                    .last()
                    .map(|m| m.seq)
                    .unwrap_or_else(|| store.latest_moment_seq().max(since_seq));
                json!({
                    "seq": seq,
                    "moments": value_of(moments),
                    "timedOut": timed_out,
                    "truncated": truncated,
                })
            }
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
                json!({ "messageId": id })
            }
            Conduct::Say {
                thread_id,
                text,
                aloud,
                urgency,
            } => {
                // The row is the proof: only a thread Boite stamped may speak
                // as the orchestrator, whatever the caller claims to be.
                let (role, scope, _) = store
                    .thread_orchestration(&thread_id)
                    .ok_or("unknown thread")?;
                if role.as_deref() != Some(crate::orchestrator::ROLE) {
                    return Err(
                        "only an orchestrator thread may say something here, \
                         and this thread is not one"
                            .to_string(),
                    );
                }
                let id = store.add_orchestrator_message(
                    scope.as_deref(),
                    "orchestrator",
                    &text,
                    aloud.as_deref(),
                    urgency.as_deref(),
                    crate::now_ms(),
                )?;
                json!({ "messageId": id })
            }
            Conduct::Messages {
                scope,
                since_id,
                limit,
            } => value_of(store.orchestrator_messages(
                scope.as_deref(),
                since_id.as_deref(),
                limit,
            )?),
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
}
