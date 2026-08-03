use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use subtle::ConstantTimeEq;

const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);

pub struct Auth {
    token: String,
    failures: Mutex<HashMap<IpAddr, Failure>>,
}

struct Failure {
    count: u32,
    locked_until: Option<Instant>,
}

impl Auth {
    pub fn new(token: String) -> Auth {
        Auth {
            token,
            failures: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_locked(&self, ip: IpAddr) -> bool {
        let map = self.failures.lock();
        match map.get(&ip).and_then(|f| f.locked_until) {
            Some(until) => Instant::now() < until,
            None => false,
        }
    }

    /// Constant-time token check. Records failures per IP and locks the IP for
    /// 60s after MAX_FAILURES bad attempts.
    pub fn verify(&self, ip: IpAddr, candidate: &str) -> bool {
        let ok: bool = candidate
            .as_bytes()
            .ct_eq(self.token.as_bytes())
            .into();
        let mut map = self.failures.lock();
        if ok {
            map.remove(&ip);
            return true;
        }
        // Bound memory under an IP-rotating spray: when the table grows large,
        // drop entries that are not actively locked.
        if map.len() > 4096 {
            let now = Instant::now();
            map.retain(|_, f| f.locked_until.map(|u| now < u).unwrap_or(false));
        }
        let entry = map.entry(ip).or_insert(Failure {
            count: 0,
            locked_until: None,
        });
        entry.count += 1;
        if entry.count >= MAX_FAILURES {
            // Keep the count across lockouts so a repeat offender stays
            // throttled (one try per LOCKOUT) instead of a fresh batch each
            // cycle.
            entry.locked_until = Some(Instant::now() + LOCKOUT);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(last: u8) -> IpAddr {
        IpAddr::from([127, 0, 0, last])
    }

    #[test]
    fn a_wrong_token_never_gets_through_and_a_right_one_always_does() {
        let auth = Auth::new("the-token".into());
        assert!(auth.verify(ip(1), "the-token"));
        assert!(!auth.verify(ip(1), "the-toke"));
        assert!(!auth.verify(ip(1), "the-tokenn"));
        assert!(!auth.verify(ip(1), ""));
    }

    /// Five tries, then the door is shut for a minute. Without this the token
    /// is guessable at whatever rate the network allows.
    #[test]
    fn an_address_that_keeps_guessing_is_locked_out() {
        let auth = Auth::new("the-token".into());
        assert!(!auth.is_locked(ip(2)));
        for _ in 0..MAX_FAILURES - 1 {
            assert!(!auth.verify(ip(2), "wrong"));
            assert!(!auth.is_locked(ip(2)), "locked too early");
        }
        assert!(!auth.verify(ip(2), "wrong"));
        assert!(auth.is_locked(ip(2)));
        // The lock is per address: one client guessing does not shut out the
        // rest of the house.
        assert!(!auth.is_locked(ip(3)));
        assert!(auth.verify(ip(3), "the-token"));
    }

    /// A success clears the count. Somebody who mistyped four times and then
    /// got it right is not one failure away from a lockout for the next hour.
    #[test]
    fn getting_it_right_forgives_what_came_before() {
        let auth = Auth::new("the-token".into());
        for _ in 0..MAX_FAILURES - 1 {
            assert!(!auth.verify(ip(4), "wrong"));
        }
        assert!(auth.verify(ip(4), "the-token"));
        for _ in 0..MAX_FAILURES - 1 {
            assert!(!auth.verify(ip(4), "wrong"));
            assert!(!auth.is_locked(ip(4)), "the count was not cleared");
        }
    }

    /// A spray from thousands of addresses must not be a way to grow the table
    /// until the process runs out of memory. What is dropped is what is not
    /// actively locked, so nobody escapes a lockout by making noise.
    #[test]
    fn a_spray_from_everywhere_does_not_grow_without_bound() {
        let auth = Auth::new("the-token".into());
        // One address earns a real lockout before the flood starts.
        for _ in 0..MAX_FAILURES {
            auth.verify(ip(9), "wrong");
        }
        assert!(auth.is_locked(ip(9)));

        for a in 0..40u8 {
            for b in 0..120u8 {
                auth.verify(IpAddr::from([10, 0, a, b]), "wrong");
            }
        }
        assert!(auth.failures.lock().len() <= 4096 + 1);
        assert!(auth.is_locked(ip(9)), "a locked address was swept away");
    }
}
