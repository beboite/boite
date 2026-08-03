//! What this shim is, and how it proves it.
//!
//! Two credentials and nothing else. A terminal Boite opened holds a key of its
//! own and signs every request; an agent wired from a credentials file presents
//! a token derived for one project. Neither can be turned into the other, and
//! `resolve` picks whichever one the process was actually given.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::Value;

use crate::http::Endpoint;
use crate::now_ms;
use crate::render::index_todos;

/// What this shim proves itself with. Exactly one of the two.
pub(crate) enum Credential {
    /// A terminal Boite opened. Signs every request with a key of its own.
    Thread {
        id: String,
        key: boite_identity::ThreadKey,
    },
    /// A credentials file, issued for one project. Nothing to sign with, and a
    /// narrower grant at the other end: it cannot move between projects.
    Project { id: String, token: String },
}

pub(crate) struct Host {
    endpoint: Endpoint,
    credential: Credential,
    /// Which agent this is, when the registration said so. Only ever used to
    /// put the right badge on a claim; it grants nothing.
    agent: Option<String>,
    /// Short id to full id, filled by every listing. The process lives as long
    /// as the agent does, so a claim can quote the eight characters it was
    /// shown instead of a full uuid. Single-threaded loop, hence `RefCell`.
    ids: RefCell<HashMap<String, String>>,
}

#[derive(serde::Deserialize)]
struct Credentials {
    url: String,
    token: String,
    #[serde(rename = "projectId")]
    project_id: String,
}

impl Host {
    /// Environment first, then the credentials file named on the command line.
    ///
    /// The environment is what Boite stamps into a terminal it launched, and it
    /// carries the thread — the most precise answer, and the only one that can
    /// sign. The file exists for agents that hand a server process nothing but
    /// PATH, where the environment can never arrive; it names a project instead,
    /// which is the unit the list belongs to anyway.
    pub(crate) fn resolve() -> Result<Host, String> {
        if let (Ok(url), Some(seed)) = (
            std::env::var(boite_identity::env::URL),
            Self::key_from_env(),
        ) {
            let thread_id = std::env::var(boite_identity::env::THREAD)
                .ok()
                .filter(|s| !s.is_empty());
            if let Some(id) = thread_id {
                return Ok(Host {
                    endpoint: Endpoint::parse(&url)?,
                    credential: Credential::Thread {
                        id,
                        key: boite_identity::ThreadKey::from_seed_hex(&seed)?,
                    },
                    // The thread names the agent better than any argument could:
                    // Boite launched it and knows what it is.
                    agent: None,
                    ids: RefCell::new(HashMap::new()),
                });
            }
        }

        let path = std::env::args().nth(1).ok_or_else(|| {
            "no Boite credentials: run this from a Boite terminal, or pass the \
             credentials file the Todo panel offers"
                .to_string()
        })?;
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read credentials at {path}: {e}"))?;
        let creds: Credentials =
            serde_json::from_str(&text).map_err(|e| format!("bad credentials file: {e}"))?;
        // The Todo panel writes the agent's own name into the line it offers,
        // because it knows which row the button was under. Without it a claim
        // arrives from "some agent" and the list can only show a generic mark.
        let agent = std::env::args().nth(2).filter(|s| !s.is_empty());
        Ok(Host {
            endpoint: Endpoint::parse(&creds.url)?,
            credential: Credential::Project {
                id: creds.project_id,
                token: creds.token,
            },
            agent,
            ids: RefCell::new(HashMap::new()),
        })
    }

    /// This thread's private key, for a terminal Boite spawned.
    ///
    /// A path, never a value: `BOITE_TOKEN` held the credential itself, so an
    /// agent typing `env` printed it into a scrollback that is kept and
    /// replayed. Neither that variable nor `BOITE_TOKEN_FILE` is read any more.
    /// A terminal still running with the old environment gets no tools rather
    /// than a weaker way in, which is the right way round for a credential.
    fn key_from_env() -> Option<String> {
        let path = std::env::var(boite_identity::env::KEY_FILE).ok()?;
        if path.trim().is_empty() {
            return None;
        }
        std::fs::read_to_string(&path)
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
    }

    pub(crate) fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let body = body.map(|b| b.to_string().into_bytes());
        // Bound before the header list, so they outlive the borrows in it.
        let (auth, stamp, signature);
        let mut headers: Vec<(&str, &str)> = Vec::with_capacity(4);
        match &self.credential {
            Credential::Thread { id, key } => {
                let ts = now_ms();
                stamp = ts.to_string();
                signature = key.sign(&boite_identity::canonical(
                    method,
                    path,
                    id,
                    ts,
                    body.as_deref().unwrap_or(&[]),
                ));
                headers.push((boite_identity::header::THREAD, id));
                headers.push((boite_identity::header::TIMESTAMP, &stamp));
                headers.push((boite_identity::header::SIGNATURE, &signature));
            }
            Credential::Project { id, token } => {
                auth = format!("Bearer {token}");
                headers.push(("Authorization", &auth));
                headers.push((boite_identity::header::PROJECT, id));
            }
        }
        if let Some(agent) = &self.agent {
            headers.push((boite_identity::header::AGENT, agent));
        }
        let res = self.endpoint.send(method, path, &headers, body)?;
        let status = res.status;
        if status == 409 {
            // The endpoint refuses without saying which reason applied; say the
            // same here rather than inventing a diagnosis. The two routes mean
            // different things by it, and telling an agent its todo is closed
            // when the real answer is "you have no worktree" sends it looking
            // in the wrong place entirely.
            return Err(if path.starts_with("/v1/worktree") {
                "this terminal has no worktree: it runs directly in the project folder, \
                 so branches here are the user's to make"
                    .into()
            } else {
                "that item is not open, or does not belong to this project".to_string()
            });
        }
        if !(200..300).contains(&status) {
            return Err(format!("boite refused the call ({status})"));
        }
        serde_json::from_slice(&res.body).map_err(|e| format!("bad response: {e}"))
    }

    pub(crate) fn remember(&self, short: &str, full: &str) {
        self.ids
            .borrow_mut()
            .insert(short.to_string(), full.to_string());
    }

    /// The full id behind whatever the agent quoted.
    ///
    /// A short id it saw in a listing this process made resolves from memory. A
    /// short id it saw before a restart does not, so the list is fetched once
    /// and asked again — one extra round trip on a path that would otherwise
    /// fail with a refusal the agent cannot act on. Anything else goes through
    /// untouched: a full uuid out of a task prompt is already the answer.
    pub(crate) fn full_id(&self, given: &str) -> String {
        if let Some(full) = self.ids.borrow().get(given) {
            return full.clone();
        }
        if given.len() >= 32 {
            return given.to_string();
        }
        if let Ok(out) = self.send("GET", "/v1/todos", None) {
            index_todos(self, &out);
        }
        self.ids
            .borrow()
            .get(given)
            .cloned()
            .unwrap_or_else(|| given.to_string())
    }
}

#[cfg(test)]
impl Host {
    /// A shim pointed at a port nothing answers on, for the renderers.
    ///
    /// They format an answer that is handed to them, so nothing they are tested
    /// on ever sends. The endpoint has to be a real one anyway because the type
    /// carries no null.
    pub(crate) fn probe() -> Host {
        Host {
            endpoint: Endpoint::parse("http://127.0.0.1:1").unwrap(),
            credential: Credential::Thread {
                id: "thread".into(),
                key: boite_identity::ThreadKey::mint(),
            },
            agent: None,
            ids: RefCell::new(HashMap::new()),
        }
    }
}
