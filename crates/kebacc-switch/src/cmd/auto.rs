use super::Options;
use crate::live;
use crate::pool::{Pool, Trust};
use crate::provider::Provider;
use crate::term::{say, Color};
use crate::usage;
use chrono::{DateTime, Utc};
use std::time::{Duration, Instant};

const BUDGET: Duration = Duration::from_secs(12);

pub fn run(provider: &Provider, opts: &Options) -> i32 {
    let note = |text: &str, colour: Color| {
        if !opts.quiet {
            say(text, colour);
        }
    };
    let started = Instant::now();
    let read = |entry: &crate::pool::Entry| {
        if started.elapsed() >= BUDGET {
            usage::from_cache(entry.cache.as_ref())
        } else {
            usage::for_entry(provider, entry, false)
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
        note(
            &format!(
                "The live {} login is not one of the saved ones. It will be backed up, not kept.",
                provider.label
            ),
            Color::Yellow,
        );
    }

    let mut blind = false;
    if let Some(current) = current {
        let usage = read(current);
        let pair = usage
            .as_ref()
            .map(|u| u.as_pair())
            .unwrap_or_else(|| "usage n/a".into());
        let known = usage.as_ref().is_some_and(usage::Usage::known);
        if known && usage.as_ref().is_some_and(usage::Usage::usable) {
            note(
                &format!("{} still has room ({pair}).", current.email),
                Color::Dim,
            );
            return 0;
        }
        if known {
            note(
                &format!("{} is out of quota ({pair}).", current.email),
                Color::Yellow,
            );
        } else {
            blind = true;
            note(
                &format!(
                    "{}: no quota reading. Looking for an account that reports room.",
                    current.email
                ),
                Color::Yellow,
            );
        }
    }

    let mut soonest: Option<DateTime<Utc>> = None;
    let mut fallback: Vec<(&crate::pool::Entry, Option<usage::Usage>)> = Vec::new();

    for entry in &pool {
        if current.is_some_and(|c| c.file == entry.file) {
            continue;
        }
        if entry.trust == Trust::Changed || entry.creds.is_none() {
            continue;
        }

        let usage = read(entry);
        let readable = usage.as_ref().is_some_and(usage::Usage::known);
        if readable && !usage.as_ref().is_some_and(usage::Usage::usable) {
            if let Some(ready) = usage.as_ref().and_then(usage::Usage::ready_at) {
                if soonest.is_none_or(|current| ready < current) {
                    soonest = Some(ready);
                }
            }
            continue;
        }
        if !readable || entry.trust != Trust::Trusted {
            fallback.push((entry, usage));
            continue;
        }
        return take(provider, entry, usage.as_ref(), &note);
    }

    if blind {
        note(
            "No account reports room either. Staying where we are rather than guessing.",
            Color::Yellow,
        );
        return 0;
    }

    if let Some((entry, usage)) = fallback.first() {
        if entry.trust != Trust::Trusted {
            note(
                &format!(
                    "{} is {}. Taking it anyway: every trusted account is out of quota.",
                    entry.email,
                    entry.trust.verdict().0
                ),
                Color::Yellow,
            );
        } else {
            note(
                &format!("{}: no quota reading, trying it anyway.", entry.email),
                Color::Dim,
            );
        }
        return take(provider, entry, usage.as_ref(), &note);
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

fn take(
    provider: &Provider,
    entry: &crate::pool::Entry,
    usage: Option<&usage::Usage>,
    note: &dyn Fn(&str, Color),
) -> i32 {
    if let Err(problem) = live::activate(provider, entry) {
        note(&problem, Color::Red);
        return 1;
    }
    let pair = usage
        .map(|u| u.as_pair())
        .unwrap_or_else(|| "usage n/a".into());
    note(
        &format!("Switched {} to {} ({pair}).", provider.label, entry.email),
        Color::Green,
    );
    10
}
