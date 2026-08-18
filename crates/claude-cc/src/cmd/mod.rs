//! One module per command, and the few things all of them need.

pub mod add;
pub mod auto;
pub mod doctor;
pub mod list;
pub mod remove;
pub mod statusline;
pub mod switch;

use crate::live;
use crate::pool::Entry;
use crate::provider::Provider;

/// Everything the command line can carry. Named options only — see `main`.
#[derive(Default)]
pub struct Options {
    pub email: Option<String>,
    pub quiet: bool,
    /// Run from a hook: say nothing, and never fail.
    pub hook: bool,
    pub refresh: bool,
    pub yes: bool,
    pub protect: bool,
    pub adopt: bool,
    pub rollback: bool,
    pub clean: bool,
}

/// Which saved login the CLI is on, by the email it is logged in as.
pub fn current<'a>(provider: &Provider, pool: &'a [Entry]) -> Option<&'a Entry> {
    let live = live::identity(provider)?;
    let email = crate::jsonio::str_of(&live, "emailAddress")?.to_lowercase();
    pool.iter().find(|e| e.email.to_lowercase() == email)
}

/// A number typed at a prompt, as an index into the pool.
pub fn chosen_index(answer: &str, count: usize) -> Option<usize> {
    let index: usize = answer.trim().parse().ok()?;
    (index >= 1 && index <= count).then(|| index - 1)
}
