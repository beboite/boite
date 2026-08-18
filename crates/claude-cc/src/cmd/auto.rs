//! Switches away from the account in use only when it is out of quota, and only
//! to one that is not.
//!
//! Exit codes are the point of this command: 0 nothing to do, 10 switched,
//! 20 every saved account is capped, 30 nothing is set up yet.

use super::Options;
use crate::live;
use crate::pool::{Pool, Trust};
use crate::provider::Provider;
use crate::term::{say, Color};
use crate::usage;
use chrono::{DateTime, Utc};

pub fn run(provider: &Provider, opts: &Options) -> i32 {
    let note = |text: &str, colour: Color| {
        if !opts.quiet {
            say(text, colour);
        }
    };

    let pool = Pool::new(provider).entries();
    if pool.len() < 2 {
        note(
            &format!(
                "Nothing to switch between: {} has {} saved account(s).",
                provider.label,
                pool.len()
            ),
            Color::Yellow,
        );
        return 30;
    }

    let current = super::current(provider, &pool);
    if current.is_none() {
        // Switching now replaces a login nothing here saved. The previous
        // credentials go to the backups first, which is where to get them back.
        note(
            &format!(
                "The live {} login is not one of the saved ones. It will be backed up, not kept.",
                provider.label
            ),
            Color::Yellow,
        );
    }
    if let Some(current) = current {
        let usage = usage::for_entry(provider, current, false);
        let pair = usage
            .as_ref()
            .map(|u| u.as_pair())
            .unwrap_or_else(|| "usage n/a".into());
        if usage.as_ref().is_none_or(|u| u.usable()) {
            note(
                &format!("{} still has room ({pair}).", current.email),
                Color::Dim,
            );
            return 0;
        }
        note(
            &format!("{} is out of quota ({pair}).", current.email),
            Color::Yellow,
        );
    }

    let mut soonest: Option<DateTime<Utc>> = None;
    for entry in &pool {
        if current.is_some_and(|c| c.file == entry.file) {
            continue;
        }
        if entry.trust == Trust::Changed || entry.creds.is_none() {
            continue;
        }

        let usage = usage::for_entry(provider, entry, false);
        if usage.as_ref().is_none_or(|u| u.usable()) {
            // Nothing is asked here — this runs unattended — so an entry this
            // machine never registered is used, and said out loud.
            if entry.trust != Trust::Trusted {
                note(
                    &format!("{} is {}.", entry.email, entry.trust.verdict().0),
                    Color::Yellow,
                );
            }
            if let Err(problem) = live::activate(provider, entry) {
                note(&problem, Color::Red);
                return 1;
            }
            let pair = usage
                .as_ref()
                .map(|u| u.as_pair())
                .unwrap_or_else(|| "usage n/a".into());
            note(
                &format!("Switched {} to {} ({pair}).", provider.label, entry.email),
                Color::Green,
            );
            return 10;
        }
        if let Some(ready) = usage.as_ref().and_then(|u| u.ready_at()) {
            if soonest.is_none_or(|current| ready < current) {
                soonest = Some(ready);
            }
        }
    }

    match soonest {
        Some(at) => note(
            &format!(
                "Every saved account is capped. The first one is back in {}.",
                usage::wait_text(at)
            ),
            Color::Red,
        ),
        None => note("Every saved account is capped.", Color::Red),
    }
    20
}
