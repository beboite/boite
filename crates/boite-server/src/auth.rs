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
        let entry = map.entry(ip).or_insert(Failure {
            count: 0,
            locked_until: None,
        });
        entry.count += 1;
        if entry.count >= MAX_FAILURES {
            entry.locked_until = Some(Instant::now() + LOCKOUT);
            entry.count = 0;
        }
        false
    }
}
