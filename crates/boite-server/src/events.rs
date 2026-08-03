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
        }
    }
}
