//! Reading this Boite's log, and writing the webview's half of it.
//!
//! The one domain whose work is a process-wide singleton rather than a store or
//! a path: `boite_core::log` owns the ring, the files and the filter, and these
//! four methods are the bus's way in. So `prepare` has nothing to resolve and
//! the refusals are the module's own: a host that never called
//! `log::init` answers an empty list rather than an error, because "this Boite
//! keeps no log" is what a test and a headless CLI both look like.
//!
//! `logs.write` is the direction that surprises people: the webview logs
//! through the bus rather than to a file of its own, so a phone's records land
//! on the server it is talking to instead of in a browser console nobody keeps.

use serde_json::{json, Value};

use crate::capability::Capability;
use crate::log::{self, Query, Record};

use super::{opt_str_param, value_of, Host, Ready, Wire};

pub const ALL_METHODS: &[&str] = &[
    "logs.tail",
    "logs.query",
    "logs.level",
    "logs.write",
    "logs.subscribe",
];

/// The ceiling on one `logs.write` batch.
///
/// The webview batches every 500 ms, so a client sending more than this in one
/// call is either wedged in a loop or is not the webview. Dropping the excess
/// is a bounded log; refusing the call would lose the whole batch.
const MAX_BATCH: usize = 500;

#[derive(Debug, Clone)]
pub enum Logs {
    /// The last records this host wrote, from memory.
    Tail {
        limit: usize,
        level: Option<String>,
        host: Option<String>,
    },
    /// Every host's files, merged on one clock.
    Query(Box<Query>),
    /// The filter directive: read it with nothing, set it with a string.
    Level { directives: Option<String> },
    /// Records a client produced, written into this host's file.
    Write {
        records: Vec<Value>,
        device: Option<String>,
    },
    /// Ask this host to push `log.record` events at this device.
    ///
    /// The bus answers whether the subscription is allowed; who to push to is
    /// the transport's own bookkeeping, because only it knows which socket the
    /// caller is on.
    Subscribe { on: bool },
}

impl Logs {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        Ok(match method {
            "logs.tail" => Logs::Tail {
                limit: usize_param(params, "limit", 200),
                level: opt_str_param(params, "level"),
                host: opt_str_param(params, "host"),
            },
            "logs.query" => Logs::Query(Box::new(Query {
                since: u64_param(params, "since"),
                until: u64_param(params, "until"),
                level: opt_str_param(params, "level"),
                host: opt_str_param(params, "host"),
                thread: opt_str_param(params, "thread"),
                turn: opt_str_param(params, "turn"),
                target: opt_str_param(params, "target"),
                text: opt_str_param(params, "text"),
                limit: params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize),
            })),
            "logs.level" => Logs::Level {
                directives: opt_str_param(params, "directives"),
            },
            "logs.write" => Logs::Write {
                records: params
                    .get("records")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default(),
                device: opt_str_param(params, "device"),
            },
            "logs.subscribe" => Logs::Subscribe {
                on: params
                    .get("on")
                    .and_then(|v| v.as_bool())
                    // Absent means "start": a client that says nothing is
                    // asking to be pushed to, which is the only reason to call.
                    .unwrap_or(true),
            },
            other => return Err(format!("unknown logs method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Logs::Tail { .. } => "logs.tail",
            Logs::Query(_) => "logs.query",
            Logs::Level { .. } => "logs.level",
            Logs::Write { .. } => "logs.write",
            Logs::Subscribe { .. } => "logs.subscribe",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Logs::Tail { .. } | Logs::Query(_) => Wire::Key("records"),
            Logs::Level { .. } => Wire::Bare,
            Logs::Write { .. } | Logs::Subscribe { .. } => Wire::Ok,
        }
    }

    pub(super) fn capability(&self) -> Capability {
        match self {
            // Reading a log is reading; so is asking to be pushed what is about
            // to be written to it.
            Logs::Tail { .. } | Logs::Query(_) | Logs::Subscribe { .. } => Capability::ReadProject,
            // Writing records is a write, and so is changing the level: a
            // read-only device turning on `trace` costs every other device the
            // bytes.
            Logs::Write { .. } | Logs::Level { .. } => Capability::MutateProject,
        }
    }

    pub(super) fn prepare(self, _host: &dyn Host) -> Result<Ready, String> {
        Ok(Ready::Work(super::Command::Logs(self)))
    }

    pub(super) fn run(self) -> Result<Value, String> {
        Ok(match self {
            Logs::Tail { limit, level, host } => {
                value_of(log::tail(limit, level.as_deref(), host.as_deref()))
            }
            Logs::Query(query) => value_of(log::query(&query)),
            Logs::Level { directives } => {
                let level = match directives {
                    Some(directives) => log::set_level(&directives)?,
                    None => log::level(),
                };
                json!({ "level": level })
            }
            Logs::Write { records, device } => {
                for value in records.into_iter().take(MAX_BATCH) {
                    log::write(from_client(&value, device.as_deref()));
                }
                json!(null)
            }
            // Nothing to do here: the transport registered the device before it
            // ever reached the bus, and the bus's answer is whether it was
            // allowed to.
            Logs::Subscribe { .. } => json!(null),
        })
    }
}

/// One record a client sent, made safe to keep.
///
/// The host is forced to `webview` and the device to the one the transport
/// authenticated, whatever the body said: a client naming itself `server` would
/// otherwise put its own lines in the middle of the server's story. `ts` is
/// kept when it is there, because a batch flushed 500 ms late is still about
/// when it happened.
fn from_client(value: &Value, device: Option<&str>) -> Record {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    let mut record = Record::new(
        "webview",
        &text("level").unwrap_or_else(|| "info".into()),
        &text("target").unwrap_or_else(|| "webview".into()),
        &text("msg").or_else(|| text("message")).unwrap_or_default(),
    );
    if let Some(ts) = value.get("ts").and_then(|v| v.as_u64()) {
        record.ts = ts;
    }
    record.thread = text("thread");
    record.turn = text("turn");
    record.request = text("request");
    record.device = device.map(str::to_string).or_else(|| text("device"));
    record.span = text("span");
    if let Some(fields) = value.get("fields").and_then(|v| v.as_object()) {
        record.fields = fields.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    }
    record
}

fn usize_param(params: &Value, key: &str, fallback: usize) -> usize {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(fallback)
}

fn u64_param(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::Command;

    fn decode(method: &str, params: Value) -> Logs {
        match Command::decode(method, &params).unwrap() {
            Command::Logs(logs) => logs,
            other => panic!("{method} decoded as {}", other.name()),
        }
    }

    /// A client says what happened; it does not get to say who it was.
    ///
    /// Both halves matter. A record claiming `host: "server"` would put a
    /// phone's lines in the middle of the server's story, and one claiming
    /// another device's id would make a filter by device a lie.
    #[test]
    fn a_written_record_is_tagged_by_the_transport_not_by_its_body() {
        let logs = decode(
            "logs.write",
            json!({
                "device": "phone-1",
                "records": [{
                    "host": "server",
                    "device": "somebody-else",
                    "level": "warn",
                    "target": "ui.frame",
                    "msg": "the pane stalled",
                    "thread": "t-7",
                    "ts": 1234,
                    "fields": { "paneId": "p1" }
                }]
            }),
        );
        let Logs::Write { records, device } = &logs else {
            panic!("not a write");
        };
        assert_eq!(device.as_deref(), Some("phone-1"));
        let record = from_client(&records[0], device.as_deref());
        assert_eq!(record.host, "webview");
        assert_eq!(record.device.as_deref(), Some("phone-1"));
        assert_eq!(record.level, "warn");
        assert_eq!(record.thread.as_deref(), Some("t-7"));
        assert_eq!(record.ts, 1234);
        assert_eq!(record.fields["paneId"], json!("p1"));
    }

    /// A record with nothing in it is still a record: the log is diagnostics,
    /// and a client with a half-built line is exactly the case being diagnosed.
    #[test]
    fn a_bare_record_gets_defaults_rather_than_a_refusal() {
        let record = from_client(&json!({}), None);
        assert_eq!(record.host, "webview");
        assert_eq!(record.level, "info");
        assert_eq!(record.target, "webview");
        assert_eq!(record.msg, "");
        assert_eq!(record.device, None);
    }

    /// The reads are reads and the two writes are writes, which is what the
    /// server's scope check reads off this domain.
    #[test]
    fn what_each_method_needs_is_what_the_scope_check_reads() {
        use Capability::*;
        for (method, expected) in [
            ("logs.tail", ReadProject),
            ("logs.query", ReadProject),
            ("logs.subscribe", ReadProject),
            ("logs.level", MutateProject),
            ("logs.write", MutateProject),
        ] {
            assert_eq!(
                decode(method, json!({})).capability(),
                expected,
                "{method}"
            );
        }
    }

    /// Every filter the contract names decodes, so a query that names one is
    /// not silently answered as if it had named none.
    #[test]
    fn a_query_carries_every_filter_it_was_given() {
        let logs = decode(
            "logs.query",
            json!({
                "since": 10, "until": 20, "level": "warn", "host": "server",
                "thread": "t1", "turn": "u1", "target": "boite_core", "text": "refused",
                "limit": 5
            }),
        );
        let Logs::Query(query) = logs else {
            panic!("not a query")
        };
        assert_eq!(query.since, Some(10));
        assert_eq!(query.until, Some(20));
        assert_eq!(query.level.as_deref(), Some("warn"));
        assert_eq!(query.host.as_deref(), Some("server"));
        assert_eq!(query.thread.as_deref(), Some("t1"));
        assert_eq!(query.turn.as_deref(), Some("u1"));
        assert_eq!(query.target.as_deref(), Some("boite_core"));
        assert_eq!(query.text.as_deref(), Some("refused"));
        assert_eq!(query.limit, Some(5));
    }
}
