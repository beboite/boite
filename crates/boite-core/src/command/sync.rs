//! Carrying an agent's configuration between computers, as capabilities.
//!
//! A domain of its own rather than eleven more methods on `sessions`, which is
//! already long enough that its own header undercounts it. Sync brings its own
//! job table, its own phases and its own failure vocabulary, and a separate
//! enum is what keeps `command::Command` a table of contents.
//!
//! Everything here acts on the machine the threads spawn on, which for a remote
//! boite is the server rather than the device drawing the panel — the same rule
//! the CLI surface follows. That is not a decision this file makes; it is what
//! being a capability on this bus means, and it is why the server needs no code
//! of its own for any of it.
//!
//! Two things are resolved during `prepare` and travel inside the command: the
//! home directory, and the switches the user set. The switches live in the
//! settings row every host already keeps, so there is exactly one answer to "is
//! this source on" and the work thread never reaches back into a store.

use std::path::PathBuf;

use serde_json::Value;

use crate::capability::Capability;
use crate::sync;

use super::{Host, Ready, Wire};

pub const ALL_METHODS: &[&str] = &[
    "sync.sources",
    "sync.status",
    "sync.probe",
    "sync.pull",
    "sync.conflicts",
    "sync.resolve",
    "sync.skip",
    "sync.push",
    "sync.cancel",
    "sync.dismiss",
    "sync.repair",
];

#[derive(Debug, Clone)]
pub enum Sync {
    /// Every source and what this machine says about it. The panel's rows.
    Sources { home: Option<PathBuf> },
    Status { home: Option<PathBuf>, config: sync::Config },
    /// Asks an address whether it is there, so the settings field can be honest
    /// without cloning anything.
    Probe { url: String },
    /// Fetches, compares, takes what only the other side changed, and reports
    /// what differs. Writes nothing the user has not agreed to and sends
    /// nothing at all.
    Pull { home: Option<PathBuf>, config: sync::Config },
    /// What is still waiting on a person, for a panel opened after the fact.
    Conflicts,
    /// The bytes a merge produced, for one file.
    ///
    /// Arbitrary content, because the merge tool can keep both sides stacked —
    /// this is not a pick-a-side enum. The path has to be one the last
    /// comparison put in front of the user, or it would be a write-anywhere
    /// primitive reachable from a webview.
    Resolve { home: Option<PathBuf>, config: sync::Config, path: String, content: String },
    /// Leaves a file as both sides have it. The next comparison asks again.
    Skip { path: String },
    /// Sends what this machine settled.
    Push { home: Option<PathBuf>, config: sync::Config },
    Cancel,
    Dismiss,
    /// Resets the mirror, and nothing outside it.
    ///
    /// Its own method rather than a flag on a pull, because a boolean on the
    /// normal path is a footgun and this is the one state a user cannot
    /// otherwise get out of.
    Repair { home: Option<PathBuf> },
}

impl Sync {
    pub(super) fn decode(method: &str, params: &Value) -> Result<Self, String> {
        Ok(match method {
            "sync.sources" => Sync::Sources { home: None },
            "sync.status" => Sync::Status { home: None, config: sync::Config::default() },
            "sync.probe" => Sync::Probe { url: str_param(params, "remoteUrl")? },
            "sync.pull" => Sync::Pull { home: None, config: sync::Config::default() },
            "sync.conflicts" => Sync::Conflicts,
            "sync.resolve" => Sync::Resolve {
                home: None,
                config: sync::Config::default(),
                path: str_param(params, "path")?,
                // Empty is a legitimate merge result: a file the user emptied on
                // purpose is still a decision.
                content: params.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
            },
            "sync.skip" => Sync::Skip { path: str_param(params, "path")? },
            "sync.push" => Sync::Push { home: None, config: sync::Config::default() },
            "sync.cancel" => Sync::Cancel,
            "sync.dismiss" => Sync::Dismiss,
            "sync.repair" => Sync::Repair { home: None },
            other => return Err(format!("unknown sync method: {other}")),
        })
    }

    pub(super) fn name(&self) -> &'static str {
        match self {
            Sync::Sources { .. } => "sync.sources",
            Sync::Status { .. } => "sync.status",
            Sync::Probe { .. } => "sync.probe",
            Sync::Pull { .. } => "sync.pull",
            Sync::Conflicts => "sync.conflicts",
            Sync::Resolve { .. } => "sync.resolve",
            Sync::Skip { .. } => "sync.skip",
            Sync::Push { .. } => "sync.push",
            Sync::Cancel => "sync.cancel",
            Sync::Dismiss => "sync.dismiss",
            Sync::Repair { .. } => "sync.repair",
        }
    }

    pub(super) fn wire(&self) -> Wire {
        match self {
            Sync::Sources { .. } => Wire::Key("sources"),
            Sync::Conflicts | Sync::Pull { .. } => Wire::Key("conflicts"),
            Sync::Cancel => Wire::Key("cancelled"),
            Sync::Dismiss | Sync::Repair { .. } => Wire::Ok,
            _ => Wire::Bare,
        }
    }

    /// What a caller has to hold.
    ///
    /// Everything that writes is `MutateAcross`, for the reason the CLI install
    /// commands are: these change the machine rather than a project, and a grant
    /// scoped to one project — the credentials file the todo panel hands to
    /// agents — must not reach them. Cancelling and dismissing touch a job row
    /// and nothing on disk.
    pub(super) fn capability(&self) -> Capability {
        match self {
            Sync::Sources { .. }
            | Sync::Status { .. }
            | Sync::Probe { .. }
            | Sync::Conflicts => Capability::ReadProject,
            Sync::Skip { .. } | Sync::Cancel | Sync::Dismiss => Capability::MutateProject,
            Sync::Pull { .. }
            | Sync::Resolve { .. }
            | Sync::Push { .. }
            | Sync::Repair { .. } => Capability::MutateAcross,
        }
    }

    pub(super) fn prepare(mut self, host: &dyn Host) -> Result<Ready, String> {
        let home = sync::home::home_dir();
        let settings = host.store().map(|store| store.load_settings().unwrap_or_default());
        let config = settings.as_ref().map(config_from).unwrap_or_default();
        match &mut self {
            Sync::Sources { home: slot } => *slot = home,
            Sync::Status { home: slot, config: into } => {
                *slot = home;
                // A host with no rows is not refused here. Status is polled, and
                // a panel that cannot even be told "nothing is set up" would
                // report a failure every half second instead.
                *into = config;
            }
            Sync::Repair { home: slot } => {
                *slot = home.ok_or("this machine has no home directory to sync")?.into();
            }
            Sync::Pull { home: slot, config: into }
            | Sync::Push { home: slot, config: into }
            | Sync::Resolve { home: slot, config: into, .. } => {
                if settings.is_none() {
                    // Anything that writes needs to know which switches are on,
                    // and a host that keeps no rows cannot say. A refusal at the
                    // boundary rather than a default that syncs nothing and
                    // looks like it worked.
                    return Err("this Boite keeps no settings, so it cannot know what to sync"
                        .to_string());
                }
                *slot = Some(home.ok_or("this machine has no home directory to sync")?);
                *into = config;
            }
            Sync::Probe { .. } | Sync::Conflicts | Sync::Skip { .. } | Sync::Cancel
            | Sync::Dismiss => {}
        }
        Ok(Ready::Work(super::Command::Sync(self)))
    }

    pub(super) fn run(self) -> Result<Value, String> {
        match self {
            Sync::Sources { home } => {
                to_value(sync::sources_blocking(home.as_deref()))
            }
            Sync::Status { home, config } => {
                to_value(sync::status_blocking(home.as_deref(), &config))
            }
            Sync::Probe { url } => to_value(sync::probe_blocking(&url)),
            Sync::Pull { home, config } => {
                let home = home.ok_or("no home directory")?;
                sync::start_blocking(&home, &config, false)?;
                to_value(sync::conflicts_blocking())
            }
            Sync::Conflicts => to_value(sync::conflicts_blocking()),
            Sync::Resolve { home, config, path, content } => {
                let home = home.ok_or("no home directory")?;
                to_value(sync::resolve_blocking(&home, &config, &path, &content)?)
            }
            Sync::Skip { path } => to_value(sync::skip_blocking(&path)?),
            Sync::Push { home, config } => {
                let home = home.ok_or("no home directory")?;
                to_value(sync::start_blocking(&home, &config, true)?)
            }
            Sync::Cancel => Ok(Value::Bool(sync::cancel())),
            Sync::Dismiss => {
                sync::dismiss();
                Ok(Value::Null)
            }
            Sync::Repair { home } => {
                let home = home.ok_or("no home directory")?;
                sync::repair_blocking(&home)?;
                Ok(Value::Null)
            }
        }
    }
}

/// Reads the switches out of the settings blob the webview writes.
///
/// The blob is opaque to the store, so this is the one place its shape is known
/// on this side. A missing key is a source that is off: nothing syncs until the
/// user says so, which is the right default for something that writes into a
/// home directory.
fn config_from(settings: &Value) -> sync::Config {
    let remote_url = settings
        .get("syncRemoteUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(str::to_string);
    let enabled = settings
        .get("syncSources")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter(|(_, on)| on.as_bool().unwrap_or(false))
                .map(|(id, _)| id.clone())
                .collect()
        })
        .unwrap_or_default();
    sync::Config { remote_url, enabled }
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

fn str_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every method decodes and names itself back, so a name in `ALL_METHODS`
    /// with no arm — or an arm with the wrong name — fails here rather than at a
    /// user.
    #[test]
    fn every_method_decodes_and_names_itself_back() {
        let params = serde_json::json!({
            "remoteUrl": "https://example.invalid/x.git",
            "path": "agents/.agents/AGENTS.md",
            "content": "",
        });
        for method in ALL_METHODS {
            let decoded = Sync::decode(method, &params)
                .unwrap_or_else(|error| panic!("{method} did not decode: {error}"));
            assert_eq!(decoded.name(), *method);
        }
    }

    #[test]
    fn a_method_nobody_declares_is_refused() {
        assert!(Sync::decode("sync.everything", &Value::Null).is_err());
    }

    /// The envelopes a remote client reads. Pinned, because the desktop and the
    /// server answer the same question and must not drift into two shapes.
    #[test]
    fn the_protocol_envelopes_are_what_shipped() {
        let params = serde_json::json!({ "remoteUrl": "x", "path": "p", "content": "" });
        let wire = |method: &str| Sync::decode(method, &params).expect("decodes").wire();
        assert_eq!(wire("sync.sources"), Wire::Key("sources"));
        assert_eq!(wire("sync.pull"), Wire::Key("conflicts"));
        assert_eq!(wire("sync.conflicts"), Wire::Key("conflicts"));
        assert_eq!(wire("sync.cancel"), Wire::Key("cancelled"));
        assert_eq!(wire("sync.dismiss"), Wire::Ok);
        assert_eq!(wire("sync.repair"), Wire::Ok);
        assert_eq!(wire("sync.status"), Wire::Bare);
    }

    /// Nothing that writes into a home directory is a read, and nothing that
    /// only touches a job row reaches across the machine.
    #[test]
    fn what_writes_is_not_labelled_a_read() {
        let params = serde_json::json!({ "remoteUrl": "x", "path": "p", "content": "" });
        let capability = |method: &str| Sync::decode(method, &params).expect("decodes").capability();
        for method in ["sync.pull", "sync.push", "sync.resolve", "sync.repair"] {
            assert_eq!(capability(method), Capability::MutateAcross, "{method}");
        }
        for method in ["sync.sources", "sync.status", "sync.probe", "sync.conflicts"] {
            assert_eq!(capability(method), Capability::ReadProject, "{method}");
        }
        for method in ["sync.skip", "sync.cancel", "sync.dismiss"] {
            assert_eq!(capability(method), Capability::MutateProject, "{method}");
        }
    }

    /// A missing switch is a switch that is off: nothing syncs until the user
    /// says so, which is the only safe default for something that writes into a
    /// home directory.
    #[test]
    fn a_source_nobody_switched_on_is_off() {
        let config = config_from(&serde_json::json!({}));
        assert!(config.enabled.is_empty());
        assert!(config.remote_url.is_none());

        let config = config_from(&serde_json::json!({
            "syncRemoteUrl": "  ",
            "syncSources": { "agents": true, "claude": false },
        }));
        assert_eq!(config.enabled, vec!["agents".to_string()]);
        assert!(config.remote_url.is_none(), "a blank address is not an address");
    }
}
