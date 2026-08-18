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
    let mut fallback: Vec<(&crate::pool::Entry, Option<usage::Usage>)> = Vec::new();

    for entry in &pool {
        if current.is_some_and(|c| c.file == entry.file) {
            continue;
        }
        if entry.trust == Trust::Changed || entry.creds.is_none() {
            continue;
        }

        let usage = usage::for_entry(provider, entry, false);
        let readable = usage.as_ref().is_some_and(|u| u.known());
        if readable && !usage.as_ref().is_some_and(|u| u.usable()) {
            if let Some(ready) = usage.as_ref().and_then(|u| u.ready_at()) {
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
