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
        }
    }
}
