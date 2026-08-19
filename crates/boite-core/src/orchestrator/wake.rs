//! Whether the sleeping orchestrator should be woken, decided from facts.
//!
//! Pure on purpose: the caller gathers what happened since the last wake and
//! this module answers `Wake` or `Sleep` with no clock, no store and no host
//! in reach, which is what makes the table below possible. Exactly one device
//! evaluates it — the one holding the orchestrator's PTY — so two windows
//! looking at the same pulse do not both wake it.
//!
//! The rules, in the order they are applied:
//!
//! 1. Past the daily token cap, nothing wakes it. The card in the chat says so
//!    and carries the button that resets the day; this module only refuses.
//! 2. A user message wakes it, always. Someone talking to a sleeping agent is
//!    the one case where every other rule is noise.
//! 3. Everything else must be worth a wake at all: only a worker reaching its
//!    prompt (`ready`) or stopping on a question (`waiting`) is. A worker that
//!    started running is not news the orchestrator can act on.
//! 4. Debounce: woken again within `debounce_ms` of the last wake, it stays
//!    asleep. The wake it already got covers this burst.
//! 5. A silence floor: the newest interesting signal must be at least
//!    `settle_ms` old. A worker flapping between phases settles within a
//!    second or two, and waking on the first flap pays a whole turn to read a
//!    state that is already stale.

/// One thing that happened, reduced to what this decision needs.
#[derive(Debug, Clone)]
pub struct Signal {
    /// The moment's kind: `chat.posted`, `thread.phase`, anything else.
    pub kind: String,
    /// For `thread.phase`, the phase the thread landed on.
    pub detail: String,
    /// When it happened, milliseconds since the epoch.
    pub at: i64,
}

/// The knobs, owned by settings and passed in resolved.
#[derive(Debug, Clone)]
pub struct Config {
    /// How long after a wake the next one is refused.
    pub debounce_ms: i64,
    /// How old the newest interesting signal must be.
    pub settle_ms: i64,
    /// Tokens the orchestrator may spend today. Zero is uncapped.
    pub daily_token_cap: u64,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            debounce_ms: 15_000,
            settle_ms: 2_000,
            daily_token_cap: 0,
        }
    }
}

/// What the caller remembers between decisions.
#[derive(Debug, Clone, Default)]
pub struct Ledger {
    /// When the orchestrator was last woken. Zero for never.
    pub last_wake_at: i64,
    /// What it has spent since midnight, in tokens.
    pub tokens_today: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Wake,
    Sleep,
}

/// The phases worth a wake. `running` is a worker doing its job, which is the
/// one state the orchestrator has nothing to add to.
fn interesting(signal: &Signal) -> bool {
    match signal.kind.as_str() {
        "chat.posted" => true,
        "thread.phase" => signal.detail == "ready" || signal.detail == "waiting",
        _ => false,
    }
}

pub fn decide(now: i64, signals: &[Signal], config: &Config, ledger: &Ledger) -> Decision {
    if config.daily_token_cap > 0 && ledger.tokens_today >= config.daily_token_cap {
        return Decision::Sleep;
    }
    // The user spoke: every damping rule below exists to save tokens on
    // machine noise, and none of them is worth making a person wait.
    if signals.iter().any(|s| s.kind == "chat.posted") {
        return Decision::Wake;
    }
    let newest = signals
        .iter()
        .filter(|s| interesting(s))
        .map(|s| s.at)
        .max();
    let Some(newest) = newest else {
        return Decision::Sleep;
    };
    if now - ledger.last_wake_at < config.debounce_ms {
        return Decision::Sleep;
    }
    if now - newest < config.settle_ms {
        return Decision::Sleep;
    }
    Decision::Wake
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(kind: &str, detail: &str, at: i64) -> Signal {
        Signal {
            kind: kind.into(),
            detail: detail.into(),
            at,
        }
    }

    #[test]
    fn the_table() {
        let config = Config::default();
        let rested = Ledger {
            last_wake_at: 0,
            tokens_today: 0,
        };
        let just_woken = Ledger {
            last_wake_at: 95_000,
            tokens_today: 0,
        };
        let capped = Ledger {
            last_wake_at: 0,
            tokens_today: 10_000,
        };
        let cap_10k = Config {
            daily_token_cap: 10_000,
            ..Config::default()
        };
        let now = 100_000;
        let cases: &[(&str, Vec<Signal>, &Config, &Ledger, Decision)] = &[
            ("nothing happened", vec![], &config, &rested, Decision::Sleep),
            (
                "a worker reached its prompt, settled",
                vec![signal("thread.phase", "ready", 90_000)],
                &config,
                &rested,
                Decision::Wake,
            ),
            (
                "a worker stopped on a question, settled",
                vec![signal("thread.phase", "waiting", 90_000)],
                &config,
                &rested,
                Decision::Wake,
            ),
            (
                "a worker merely started running",
                vec![signal("thread.phase", "running", 90_000)],
                &config,
                &rested,
                Decision::Sleep,
            ),
            (
                "an uninteresting kind",
                vec![signal("todo.added", "", 90_000)],
                &config,
                &rested,
                Decision::Sleep,
            ),
            (
                "still inside the debounce window",
                vec![signal("thread.phase", "ready", 90_000)],
                &config,
                &just_woken,
                Decision::Sleep,
            ),
            (
                "the signal has not settled yet",
                vec![signal("thread.phase", "ready", 99_500)],
                &config,
                &rested,
                Decision::Sleep,
            ),
            (
                "a user message wakes it through the debounce",
                vec![signal("chat.posted", "", 99_900)],
                &config,
                &just_woken,
                Decision::Wake,
            ),
            (
                "past the daily cap, even a user message sleeps",
                vec![signal("chat.posted", "", 90_000)],
                &cap_10k,
                &capped,
                Decision::Sleep,
            ),
            (
                "an uncapped ledger ignores what was spent",
                vec![signal("thread.phase", "ready", 90_000)],
                &config,
                &capped,
                Decision::Wake,
            ),
        ];
        for (name, signals, config, ledger, expected) in cases {
            assert_eq!(
                decide(now, signals, config, ledger),
                *expected,
                "case: {name}"
            );
        }
    }
}
