//! The one HTTP client this shim needs: five verbs, one loopback address, no
//! TLS, no redirects, no keep-alive.
//!
//! It replaces reqwest, which brought hyper, tokio and 180-odd crates with it,
//! spawned a runtime thread at startup, and read the machine's proxy variables —
//! so a workstation with `ALL_PROXY` set sent a request for `127.0.0.1` out to
//! the internet. None of that is worth paying for on a socket the same machine
//! is listening on, in a binary that is spawned once per agent terminal.
//!
//! `Connection: close` on every request, so the answer is whatever arrives
//! before EOF. That costs one handshake per call on loopback and removes the
//! only part of HTTP/1.1 that needs real parsing.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Generous: `worktree_branch` waits on git, which waits on a disk.
const IO_TIMEOUT: Duration = Duration::from_secs(20);

pub struct Endpoint {
    authority: String,
    /// Whatever the url carried after the host, so a future endpoint mounted
    /// under a prefix keeps working.
    prefix: String,
}

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Endpoint {
    /// Only `http://`: this address comes out of Boite's own environment and
    /// always names a loopback port. An `https://` url would need a TLS stack,
    /// which is the dependency this module exists to avoid, so it is refused
    /// rather than silently downgraded.
    pub fn parse(url: &str) -> Result<Endpoint, String> {
        let rest = url
            .strip_prefix("http://")
            .ok_or_else(|| format!("boite url is not http: {url}"))?;
        let (authority, prefix) = match rest.find('/') {
            Some(i) => (&rest[..i], rest[i..].trim_end_matches('/')),
            None => (rest, ""),
        };
        if authority.is_empty() {
            return Err(format!("boite url has no host: {url}"));
        }
        Ok(Endpoint {
            authority: authority.to_string(),
            prefix: prefix.to_string(),
        })
    }

    pub fn send(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Result<Response, String> {
        let addr = self
            .authority
            .to_socket_addrs()
            .map_err(|e| format!("boite unreachable: {e}"))?
            .next()
            .ok_or_else(|| format!("boite unreachable: {} resolves to nothing", self.authority))?;
        let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
            .map_err(|e| format!("boite unreachable: {e}"))?;
        stream.set_read_timeout(Some(IO_TIMEOUT)).ok();
        stream.set_write_timeout(Some(IO_TIMEOUT)).ok();
        // The requests are two hundred bytes; Nagle would only hold them back
        // waiting for a second write that never comes.
        stream.set_nodelay(true).ok();

        let mut req = Vec::with_capacity(512);
        let _ = write!(
            req,
            "{method} {}{path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n",
            self.prefix, self.authority
        );
        for (name, value) in headers {
            let _ = write!(req, "{name}: {value}\r\n");
        }
        match &body {
            Some(b) => {
                let _ = write!(
                    req,
                    "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                    b.len()
                );
                req.extend_from_slice(b);
            }
            None => req.extend_from_slice(b"\r\n"),
        }

        stream
            .write_all(&req)
            .map_err(|e| format!("boite unreachable: {e}"))?;
        stream.flush().ok();

        let mut raw = Vec::with_capacity(4096);
        stream
            .read_to_end(&mut raw)
            .map_err(|e| format!("boite went quiet: {e}"))?;
        parse(&raw)
    }
}

fn parse(raw: &[u8]) -> Result<Response, String> {
    let head_end = find(raw, b"\r\n\r\n").ok_or("boite sent a truncated response")?;
    let head = std::str::from_utf8(&raw[..head_end]).map_err(|_| "boite sent a broken header")?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or("boite sent no status")?;
    let chunked = lines.any(|l| {
        let (name, value) = l.split_once(':').unwrap_or((l, ""));
        name.eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
    });

    let body = &raw[head_end + 4..];
    let body = if chunked { dechunk(body)? } else { body.to_vec() };
    Ok(Response { status, body })
}

/// The endpoint answers small json bodies, which hyper sends with a
/// `Content-Length`. Chunked is handled anyway because the alternative is a
/// parse error the day one answer grows past its buffer.
fn dechunk(mut body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(body.len());
    loop {
        let line_end = find(body, b"\r\n").ok_or("boite sent a truncated chunk")?;
        let size = std::str::from_utf8(&body[..line_end])
            .ok()
            .and_then(|l| usize::from_str_radix(l.split(';').next().unwrap_or(l).trim(), 16).ok())
            .ok_or("boite sent a bad chunk size")?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if body.len() < size {
            return Err("boite sent a short chunk".to_string());
        }
        out.extend_from_slice(&body[..size]);
        // Past the chunk and its trailing CRLF.
        body = body.get(size + 2..).unwrap_or(&[]);
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_splits_into_authority_and_prefix() {
        let e = Endpoint::parse("http://127.0.0.1:7409").unwrap();
        assert_eq!(e.authority, "127.0.0.1:7409");
        assert_eq!(e.prefix, "");
        let e = Endpoint::parse("http://boite.local:80/api/").unwrap();
        assert_eq!(e.authority, "boite.local:80");
        assert_eq!(e.prefix, "/api");
    }

    #[test]
    fn https_is_refused_rather_than_downgraded() {
        assert!(Endpoint::parse("https://127.0.0.1:7409").is_err());
        assert!(Endpoint::parse("http://").is_err());
    }

    #[test]
    fn a_plain_response_yields_status_and_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"todos\":[]}\n";
        let res = parse(raw).unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.body, b"{\"todos\":[]}\n");
    }

    #[test]
    fn a_refusal_keeps_its_code() {
        let raw = b"HTTP/1.1 409 Conflict\r\ncontent-length: 0\r\n\r\n";
        assert_eq!(parse(raw).unwrap().status, 409);
    }

    #[test]
    fn a_chunked_response_is_reassembled() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1,\r\n5\r\n\"b\":2\r\n0\r\n\r\n";
        let res = parse(raw).unwrap();
        assert_eq!(res.body, b"{\"a\":1,\"b\":2");
    }

    #[test]
    fn a_truncated_response_is_an_error_not_a_panic() {
        assert!(parse(b"HTTP/1.1 200 OK\r\n").is_err());
        assert!(parse(b"\r\n\r\n").is_err());
    }
}
