//! What the agents left behind, and what this machine can run.
//!
//! Twelve capabilities with one thing in common: they answer for the machine the
//! agents run on, not for the device drawing the screen. A browser cannot ask
//! its own filesystem which shells are installed, and a Windows desktop driving
//! a Linux boite would answer for itself and then offer a shell that is not
//! there.
//!
//! The only host this domain needs is a process registry, and only for one
//! command. Nothing here takes a path through the trust boundary: the working
//! directories are compared as strings against what the agents recorded and are
//! never opened, which is what lets a project's worktrees stay in the list
//! without widening anything.

use serde_json::Value;

use super::{
    opt_str_param, str_list, str_param, u32_param, value_of, Command, Host, Ready, Wire,
};
use crate::capability::Capability;
use crate::{fastpick, session, shell, usage};

/// Every method in this domain, in the order they appear below.
pub const ALL_METHODS: &[&str] = &[
    "session.find",
    "session.liveClaude",
    "session.agentTurns",
    "session.usage",
    "session.stopClaude",
    "session.copilotResumable",
    "session.migrate",
    "shell.default",
    "shell.available",
    "shell.commandExists",
    "fastpick.list",
    "fastpick.version",
];

/// Which PTY the caller is, for the one command that has to tell its own live
/// session from a neighbour's.
///
/// A pid the caller sent could name any process on the machine. This is a pty id
/// the host itself minted, turned into a pid by the host's own registry — and
/// resolved in `prepare` rather than passed in, because the pid changes on every
/// respawn while the id does not.
#[derive(Debug, Clone)]
pub enum Own {
    /// What the caller said. Only ever seen before `prepare`.
    Pty(Option<String>),
    /// What the host answered.
    Pid(Option<u32>),
}

#[derive(Debug, Clone)]
pub enum Sessions {
    /// The session an agent opened in this directory, if it is not one the
    /// caller already has or one somebody else is holding open.
    ///
    /// One command with a `kind`, which is how the server always had it. The
    /// desktop had eight, one per agent, each a copy of the same four lines.
    Find {
        kind: String,
        cwd: String,
        after_unix_ms: i64,
        exclude_ids: Vec<String>,
        own: Own,
    },
    /// Sessions claude still has open. Clients ask before replaying a captured
    /// id: claude refuses `--resume` for anything it is holding.
    LiveClaude,
    /// What each named thread's agent is doing, scoped to the threads the caller
    /// actually has. Reading these stores costs a directory walk or a database
    /// open apiece, so nobody enumerates every agent's history on a timer.
    AgentTurns { queries: Vec<session::TurnQuery> },
    /// Tokens and money per directory, from the transcripts on this machine.
    Usage { cwds: Vec<String>, days: u32 },
    StopClaude { session_id: String },
    /// Copilot turns down an id whose session was opened and never used.
    CopilotResumable { session_id: String },
    /// A thread that changed project changed the folder its agent searches for
    /// transcripts, so the file has to follow it.
    Migrate {
        kind: String,
        session_id: String,
        from_cwd: String,
        to_cwd: String,
    },
    ShellDefault,
    /// `refresh` is how a caller that just watched an install says so: the probe
    /// is cached with a TTL, which is otherwise the only way a newly installed
    /// shell is ever noticed.
    ShellAvailable { refresh: bool },
    /// The setup wizard asking whether an agent is installed. This machine's
    /// PATH decides, not the PATH of whatever device is drawing the question.
    CommandExists { cmd: String },
    /// fastpick's own JSON, passed through as a string rather than reparsed: the
    /// schema is fastpick's to grow, and the client types what it reads.
    FastpickList {
        provider: Option<String>,
        refresh: bool,
    },
    /// Null means no fastpick here, which is a state the settings panel draws
    /// rather than an error it reports.
    FastpickVersion,
}

impl Sessions {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        Ok(match method {
            "session.find" => Sessions::Find {
                kind: str_param(params, "kind")?,
                cwd: str_param(params, "cwd")?,
                after_unix_ms: params
                    .get("afterUnixMs")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                exclude_ids: str_list(params, "excludeIds"),
                own: Own::Pty(opt_str_param(params, "ptyId")),
            },
            "session.liveClaude" => Sessions::LiveClaude,
            "session.agentTurns" => Sessions::AgentTurns {
                queries: params
                    .get("queries")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|e| format!("bad queries: {e}"))?
                    .unwrap_or_default(),
            },
            "session.usage" => Sessions::Usage {
                cwds: str_list(params, "cwds"),
                days: u32_param(params, "days", 365),
            },
            "session.stopClaude" => Sessions::StopClaude {
                session_id: str_param(params, "sessionId")?,
            },
            "session.copilotResumable" => Sessions::CopilotResumable {
                session_id: str_param(params, "sessionId")?,
            },
            "session.migrate" => Sessions::Migrate {
                kind: str_param(params, "kind")?,
                session_id: str_param(params, "sessionId")?,
                from_cwd: str_param(params, "fromCwd")?,
                to_cwd: str_param(params, "toCwd")?,
            },
            "shell.default" => Sessions::ShellDefault,
            "shell.available" => Sessions::ShellAvailable {
                refresh: super::bool_param(params, "refresh", false),
            },
            "shell.commandExists" => Sessions::CommandExists {
                cmd: str_param(params, "cmd")?,
            },
            "fastpick.list" => Sessions::FastpickList {
                provider: opt_str_param(params, "provider"),
                refresh: super::bool_param(params, "refresh", false),
            },
            "fastpick.version" => Sessions::FastpickVersion,
            other => return Err(format!("unknown method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Sessions::Find { .. } => "session.find",
            Sessions::LiveClaude => "session.liveClaude",
            Sessions::AgentTurns { .. } => "session.agentTurns",
            Sessions::Usage { .. } => "session.usage",
            Sessions::StopClaude { .. } => "session.stopClaude",
            Sessions::CopilotResumable { .. } => "session.copilotResumable",
            Sessions::Migrate { .. } => "session.migrate",
            Sessions::ShellDefault => "shell.default",
            Sessions::ShellAvailable { .. } => "shell.available",
            Sessions::CommandExists { .. } => "shell.commandExists",
            Sessions::FastpickList { .. } => "fastpick.list",
            Sessions::FastpickVersion => "fastpick.version",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Sessions::Find { .. } => Wire::Key("session"),
            Sessions::LiveClaude => Wire::Key("sessions"),
            Sessions::AgentTurns { .. } => Wire::Key("turns"),
            Sessions::Usage { .. } => Wire::Bare,
            Sessions::StopClaude { .. } => Wire::Key("stopped"),
            Sessions::CopilotResumable { .. } => Wire::Key("resumable"),
            Sessions::Migrate { .. } => Wire::Key("migrated"),
            Sessions::ShellDefault => Wire::Key("shell"),
            Sessions::ShellAvailable { .. } => Wire::Key("shells"),
            Sessions::CommandExists { .. } => Wire::Key("found"),
            Sessions::FastpickList { .. } => Wire::Key("json"),
            Sessions::FastpickVersion => Wire::Key("version"),
        }
    }

    /// What a caller needs to hold to ask for this.
    ///
    /// Most of the domain reads what the agents left on disk, which is a read
    /// however many directories it walks. The two that are not are the two that
    /// reach a process or move a file: stopping a claude session, and following
    /// a thread's transcript into its new folder.
    pub(super) fn capability(&self) -> Capability {
        match self {
            Sessions::Find { .. }
            | Sessions::LiveClaude
            | Sessions::AgentTurns { .. }
            | Sessions::Usage { .. }
            | Sessions::CopilotResumable { .. }
            | Sessions::ShellDefault
            | Sessions::ShellAvailable { .. }
            | Sessions::CommandExists { .. }
            | Sessions::FastpickList { .. }
            | Sessions::FastpickVersion => Capability::ReadProject,

            Sessions::StopClaude { .. } | Sessions::Migrate { .. } => Capability::MutateProject,
        }
    }

    pub(super) fn prepare(mut self, host: &dyn Host) -> Result<Ready, String> {
        if let Sessions::Find { own, .. } = &mut self {
            if let Own::Pty(pty_id) = own {
                *own = Own::Pid(pty_id.as_deref().and_then(|id| host.child_pid(id)));
            }
        }
        Ok(Ready::Work(Command::Sessions(self)))
    }

    pub(super) fn run(self) -> Result<Value, String> {
        Ok(match self {
            Sessions::Find {
                kind,
                cwd,
                after_unix_ms,
                exclude_ids,
                own,
            } => {
                let exclude = session::build_exclude(Some(exclude_ids));
                let own_pid = match own {
                    Own::Pid(pid) => pid,
                    // Unreachable through `Command::prepare`, which is the only
                    // way to get here. Answering as if no PTY was named beats a
                    // panic: the caller loses one tie-break, not its session.
                    Own::Pty(_) => None,
                };
                match kind.as_str() {
                    "claude" => value_of(session::find_claude_session_blocking(
                        cwd,
                        after_unix_ms,
                        &exclude,
                        own_pid,
                    )),
                    "codex" => value_of(session::find_codex_session_blocking(
                        cwd,
                        after_unix_ms,
                        &exclude,
                    )),
                    "opencode" => value_of(session::find_opencode_session_blocking(
                        cwd,
                        after_unix_ms,
                        &exclude,
                    )),
                    "cursor" => value_of(session::find_cursor_session_blocking(
                        cwd,
                        after_unix_ms,
                        &exclude,
                    )),
                    "antigravity" => value_of(session::find_antigravity_session_blocking(
                        cwd,
                        after_unix_ms,
                        &exclude,
                    )),
                    "copilot" => value_of(session::find_copilot_session_blocking(
                        cwd,
                        after_unix_ms,
                        &exclude,
                    )),
                    "grok" => value_of(session::find_grok_session_blocking(
                        cwd,
                        after_unix_ms,
                        &exclude,
                    )),
                    "hermes" => value_of(session::find_hermes_session_blocking(
                        cwd,
                        after_unix_ms,
                        &exclude,
                    )),
                    // An agent nothing detects has no session, which is the same
                    // answer as an agent that has not started one.
                    _ => Value::Null,
                }
            }
            Sessions::LiveClaude => value_of(session::live_claude_sessions()),
            Sessions::AgentTurns { queries } => value_of(session::agent_turns(&queries)),
            Sessions::Usage { cwds, days } => value_of(usage::collect_usage_blocking(cwds, days)),
            Sessions::StopClaude { session_id } => {
                value_of(session::stop_claude_session(&session_id))
            }
            Sessions::CopilotResumable { session_id } => {
                value_of(session::copilot_session_resumable(&session_id))
            }
            Sessions::Migrate {
                kind,
                session_id,
                from_cwd,
                to_cwd,
            } => value_of(session::migrate_session_blocking(
                &kind,
                &session_id,
                &from_cwd,
                &to_cwd,
            )?),
            Sessions::ShellDefault => value_of(shell::default_shell_blocking()),
            Sessions::ShellAvailable { refresh } => {
                if refresh {
                    shell::forget_available_shells();
                }
                value_of(shell::available_shells_blocking())
            }
            Sessions::CommandExists { cmd } => value_of(shell::command_exists(&cmd)),
            Sessions::FastpickList { provider, refresh } => {
                value_of(fastpick::list_blocking(provider, refresh)?)
            }
            Sessions::FastpickVersion => value_of(fastpick::version_blocking()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Grant;
    use crate::command::Scoped;
    use crate::scope::ProjectRoots;
    use serde_json::json;

    #[test]
    fn every_method_decodes_and_names_itself_back() {
        let params = json!({
            "kind": "claude",
            "cwd": "/w",
            "sessionId": "s",
            "fromCwd": "/a",
            "toCwd": "/b",
            "cmd": "claude",
            "cwds": ["/w"],
        });
        for method in ALL_METHODS {
            let command = Command::decode(method, &params)
                .unwrap_or_else(|err| panic!("{method} did not decode: {err}"));
            assert_eq!(command.name(), *method);
        }
    }

    /// A pty id names a process only the host can look up, and the pid changes
    /// on every respawn while the id does not. A host with no registry answers
    /// nothing, which costs the caller one tie-break rather than its session.
    #[test]
    fn the_host_answers_which_process_a_pty_is_running() {
        let roots = ProjectRoots::default();
        let host = Scoped::new(&roots);
        let ready = Command::decode(
            "session.find",
            &json!({ "kind": "claude", "cwd": "/w", "ptyId": "pty-1" }),
        )
        .unwrap()
        .prepare(&host, Grant::Local)
        .unwrap();
        match ready {
            Ready::Work(Command::Sessions(Sessions::Find { own, .. })) => {
                assert!(matches!(own, Own::Pid(None)));
            }
            _ => panic!("session.find did not come back as work"),
        }
    }

    /// An agent no detector knows has no session, which is what a thread that
    /// has not started one looks like too. Neither is an error.
    #[test]
    fn an_agent_nothing_detects_simply_has_no_session() {
        let roots = ProjectRoots::default();
        let answer = Command::decode(
            "session.find",
            &json!({ "kind": "nothing-like-that", "cwd": "/w" }),
        )
        .unwrap()
        .prepare(&Scoped::new(&roots), Grant::Local)
        .unwrap()
        .run()
        .unwrap();
        assert_eq!(answer, Value::Null);
    }
}
