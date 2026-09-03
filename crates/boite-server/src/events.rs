use crate::protocol::Event;

// Server-side events fanned out to every connected client and consumed by the
// persistence task. Structured (not pre-serialized JSON) so the persistence
// task can act on status/title transitions without re-parsing.
#[derive(Clone, Debug)]
pub enum AppEvent {
    ThreadStatus {
        thread_id: String,
        status: String,
        exit_code: Option<i32>,
    },
    ThreadTitle {
        thread_id: String,
        title: String,
    },
    ThreadCreated(serde_json::Value),
    ThreadUpdated(serde_json::Value),
    ThreadDeleted {
        thread_id: String,
    },
    ProjectChanged,
    SettingsChanged,
    /// Someone wrote the todo table — a connected client, or an agent through
    /// the MCP endpoint. Clients reload rather than receive the row, since the
    /// writer may not be a client at all.
    TodosChanged,
    /// Something is waiting on the user. See `boite_core::approval`.
    ApprovalsChanged,
    WorkspaceInfo {
        name: Option<String>,
        color: Option<String>,
    },
    /// An agent asked for something only a client can carry out: moving its
    /// thread into another project, creating a project, opening a second
    /// terminal. All three mean killing or spawning a PTY and rearranging rows
    /// the client owns, so the endpoint decides whether the request makes sense
    /// and the client does the work.
    ///
    /// Fanned out to every connected device, because the server has no way to
    /// know which of them is looking — but carried out by exactly one: each
    /// request carries an id, and a client claims it through
    /// `agent.claimRequest` before acting. Two devices running the same move
    /// would kill one PTY twice and open two worktrees for one thread.
    AgentRequest(serde_json::Value),
    /// A device joined or was renamed. Every open devices screen reloads; the
    /// row is not carried, because the writer may be a phone that has just
    /// finished pairing and holds no socket yet.
    PairingsChanged,
    /// A moment landed on the workspace pulse. Carries only the sequence:
    /// whoever cares reads by cursor, so the row itself never rides the fanout.
    MomentAppended {
        seq: i64,
    },
    /// The orchestrator conversation moved — a reply through `/v1/say`, or a
    /// role stamped by `orchestrator.start`. Chats re-read by cursor.
    OrchestratorChanged,
    /// A line was queued for a thread's prompt. The device that owns the
    /// target PTY drains and types; everyone else ignores it.
    DispatchQueued {
        thread_id: String,
        dispatch_id: String,
    },
    /// An orchestrator put a finished worker away. Thread lists re-read.
    ThreadDismissed {
        thread_id: String,
    },
    /// Records this process just wrote, for the devices that asked.
    ///
    /// Coalesced upstream, in batches of at most fifty or every 250 ms: one
    /// event per record would put a broadcast on the log's own write path, and
    /// a busy second writes hundreds. Fanned out like everything else, and
    /// filtered per connection: a device that never called `logs.subscribe`
    /// pays nothing for the ones that did.
    LogRecords {
        records: std::sync::Arc<Vec<serde_json::Value>>,
    },
    /// One device is out, as of now.
    ///
    /// Broadcast rather than left to the next call, and this is the half that
    /// reaches a socket sitting idle with a terminal attached: the connection
    /// holding this pairing drops the moment it reads this, so a revoked phone
    /// stops seeing output rather than stopping at its next RPC. The per-call
    /// database check in `authz` is the other half, for a socket whose control
    /// task fell behind and missed this.
    PairingRevoked {
        pairing_id: String,
    },
}

impl AppEvent {
    pub fn to_event(&self) -> Event {
        match self {
            AppEvent::ThreadStatus {
                thread_id,
                status,
                exit_code,
            } => Event::new(
                "thread.status",
                serde_json::json!({ "threadId": thread_id, "status": status, "exitCode": exit_code }),
            ),
            AppEvent::ThreadTitle { thread_id, title } => Event::new(
                "thread.title",
                serde_json::json!({ "threadId": thread_id, "title": title }),
            ),
            AppEvent::ThreadCreated(thread) => {
                Event::new("thread.created", serde_json::json!({ "thread": thread }))
            }
            AppEvent::ThreadUpdated(thread) => {
                Event::new("thread.updated", serde_json::json!({ "thread": thread }))
            }
            AppEvent::ThreadDeleted { thread_id } => {
                Event::new("thread.deleted", serde_json::json!({ "threadId": thread_id }))
            }
            AppEvent::ProjectChanged => Event::new("project.changed", serde_json::json!({})),
            AppEvent::SettingsChanged => Event::new("settings.changed", serde_json::json!({})),
            AppEvent::TodosChanged => Event::new("todos.changed", serde_json::json!({})),
            AppEvent::ApprovalsChanged => Event::new("approvals.changed", serde_json::json!({})),
            AppEvent::WorkspaceInfo { name, color } => Event::new(
                "workspace.info",
                serde_json::json!({ "name": name, "color": color }),
            ),
            AppEvent::AgentRequest(request) => Event::new("agent.request", request.clone()),
            AppEvent::PairingsChanged => Event::new("pairings.changed", serde_json::json!({})),
            AppEvent::MomentAppended { seq } => {
                Event::new("moment.appended", serde_json::json!({ "seq": seq }))
            }
            AppEvent::OrchestratorChanged => {
                Event::new("orchestrator.changed", serde_json::json!({}))
            }
            AppEvent::DispatchQueued {
                thread_id,
                dispatch_id,
            } => Event::new(
                "dispatch.queued",
                serde_json::json!({ "threadId": thread_id, "dispatchId": dispatch_id }),
            ),
            AppEvent::ThreadDismissed { thread_id } => Event::new(
                "thread.dismissed",
                serde_json::json!({ "threadId": thread_id }),
            ),
            AppEvent::LogRecords { records } => Event::new(
                "log.record",
                serde_json::json!({ "records": records.as_ref() }),
            ),
            // Named on the wire so every *other* device can refresh its list.
            // The one being revoked never reads it: its socket is closed by the
            // task that received it.
            AppEvent::PairingRevoked { pairing_id } => Event::new(
                "pairing.revoked",
                serde_json::json!({ "pairingId": pairing_id }),
            ),
        }
    }
}
