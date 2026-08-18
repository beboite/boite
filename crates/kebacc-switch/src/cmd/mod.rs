pub mod add;
pub mod auto;
pub mod countdown;
pub mod doctor;
pub mod list;
pub mod midtask;
pub mod remove;
pub mod statusline;
pub mod switch;
pub mod update;

use crate::live;
use crate::pool::Entry;
use crate::provider::Provider;

#[derive(Default)]
pub struct Options {
    pub email: Option<String>,
    pub quiet: bool,
    pub hook: bool,
    pub refresh: bool,
    pub yes: bool,
    pub protect: bool,
    pub adopt: bool,
    pub rollback: bool,
    pub clean: bool,
    pub countdown: bool,
    pub midtask: bool,
    pub check: bool,
    pub spawned: bool,
}

pub fn current<'a>(provider: &Provider, pool: &'a [Entry]) -> Option<&'a Entry> {
    let live = live::identity(provider)?;
    let email = crate::jsonio::str_of(&live, "emailAddress")?.to_lowercase();
    pool.iter().find(|e| e.email.to_lowercase() == email)
}

pub fn chosen_index(answer: &str, count: usize) -> Option<usize> {
    let index: usize = answer.trim().parse().ok()?;
    (index >= 1 && index <= count).then(|| index - 1)
}
