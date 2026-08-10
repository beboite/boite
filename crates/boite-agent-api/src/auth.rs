//! Who is calling, proved before anything is routed.
//!
//! There used to be one bearer token for every agent in a workspace. It said
//! the caller came from Boite and nothing more; which project it could reach
//! came from a header, and that header was a string the caller chose. Any agent
//! could read another's and write its own. On the desktop it was worse: a
//! caller who sent no thread at all fell back to its working directory, so the
//! project it reached was whichever one happened to contain a path it named.
//!
//! Two credentials now, neither convertible into the other, and both checked
//! here in [`identify`] before a route is picked:
//!
//! - **A thread key.** Minted when Boite spawned the terminal, public half on
//!   the thread's row, private half in a file only that user can read. The
//!   agent signs the request. Nothing reusable is sent, and a thread cannot
//!   speak for another because it does not hold its key. Grant: everything.
//! - **A project token.** For agents Boite could hand nothing at launch, which
//!   arrive through a credentials file instead. Derived from the workspace
//!   secret and the project id, so editing the id in the file produces a token
//!   that no longer verifies. Grant: that one project, no calls across.
//!
//! Anything else is a 401. A thread id with no signature, a signature with no
//! key on the row, a working directory: all of them used to be a way in and
//! none of them is one now. There is no migration path for a thread spawned
//! before keys existed, and that is the correct answer rather than a gap: an
//! identity handed to whoever asks first is not an identity.
//!
//! A middleware rather than a call at the top of each handler, which is what it
//! was. Eleven handlers each beginning with the same line is eleven chances for
//! the twelfth to be written without it.

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use subtle::ConstantTimeEq;

use boite_core::capability::{Capability, Grant};
use boite_identity::header;

use crate::Shared;

/// What a request body may be before it is refused.
///
/// The largest thing anyone sends here is an artifact policy, which is a list
/// of directory names. A megabyte is four orders of magnitude of headroom and
/// still bounds what has to be buffered to check a signature.
const MAX_BODY: usize = 1024 * 1024;

/// Who is calling, once it has been proved.
///
/// Built in [`identify`] and attached to the request, so a handler takes it as
/// an extractor and cannot construct one. Same shape of guarantee as
/// `boite_core::command::Ready`: the check is not something a handler can skip,
/// because the thing it produces is the only way in.
#[derive(Clone, Debug)]
pub struct Caller {
    /// The project this caller answers for. Never taken from a header the
    /// caller could have chosen.
    pub project_id: String,
    /// The thread it is, when the credential was a thread key. `None` for a
    /// credentials file, which names a project and has no terminal behind it.
    pub thread_id: Option<String>,
    pub grant: Grant,
    /// Which agent is speaking, for the badge on a claim. Grants nothing.
    pub agent: Option<String>,
}

impl Caller {
    /// The thread behind this caller, for anything that acts on the terminal.
    ///
    /// `BAD_REQUEST` rather than `UNAUTHORIZED`: the credential is fine, it
    /// simply is not one that has a terminal, and an agent wired from a file
    /// should read that as "this call is not for you" rather than as a bad
    /// token it should go and fix.
    pub fn thread(&self) -> Result<&str, StatusCode> {
        self.thread_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or(StatusCode::BAD_REQUEST)
    }

    /// The thread id for the log and the activity pulse, empty when there is
    /// none. Attribution, never a decision.
    pub fn thread_or_empty(&self) -> &str {
        self.thread_id.as_deref().unwrap_or("")
    }

    /// Whether this caller may ask for that. The sentence is what the agent
    /// reads.
    pub fn ensure(&self, capability: Capability) -> Result<(), String> {
        self.grant.ensure(capability)
    }
}

/// Proves the caller, or refuses the request. Runs before every route.
pub async fn identify(
    State(workspace): State<Shared>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, MAX_BODY)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;

    // Path *and* query, which is the whole request line a client sent. Signing
    // the path alone would leave `?threadId=` outside the signature, and that
    // parameter is which terminal's output comes back.
    let path = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or_else(|| parts.uri.path());
    let caller = prove(
        &*workspace,
        parts.method.as_str(),
        path,
        &parts.headers,
        &bytes,
        now_ms(),
    )?;

    let mut request = Request::from_parts(parts, Body::from(bytes));
    request.extensions_mut().insert(caller);
    Ok(next.run(request).await)
}

/// The whole decision, with the clock passed in so it can be tested.
///
/// Every refusal is a status and nothing else. Which of the checks failed is
/// not in the answer: it is in the journal, where the user can read it and the
/// caller cannot.
fn prove(
    workspace: &dyn crate::Workspace,
    method: &str,
    path: &str,
    headers: &HeaderMap,
    body: &Bytes,
    now: i64,
) -> Result<Caller, StatusCode> {
    let thread_id = header_str(headers, header::THREAD);
    if !thread_id.is_empty() {
        return signed(workspace, method, path, headers, body, now, thread_id);
    }
    issued(workspace, headers)
}

/// A terminal Boite opened, signing with the key it was minted.
fn signed(
    workspace: &dyn crate::Workspace,
    method: &str,
    path: &str,
    headers: &HeaderMap,
    body: &Bytes,
    now: i64,
    thread_id: &str,
) -> Result<Caller, StatusCode> {
    let ts: i64 = header_str(headers, header::TIMESTAMP)
        .parse()
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    if !boite_identity::fresh(ts, now) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let public_key = workspace
        .store()
        .public_key_of_thread(thread_id)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let message = boite_identity::canonical(method, path, thread_id, ts, body);
    if !boite_identity::verify(
        &public_key,
        &message,
        header_str(headers, header::SIGNATURE),
    ) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // Only now is the id worth reading a row by. The project comes from the
    // thread, never from the request.
    let project_id = workspace
        .store()
        .project_of_thread(thread_id)
        .map_err(|_| StatusCode::NOT_FOUND)?;
    // The thread carries the icon key already, which is what the sidebar draws,
    // so a claim can be shown under the badge of the agent that made it.
    let agent = workspace
        .store()
        .agent_of_thread(thread_id)
        .filter(|k| !k.is_empty());
    Ok(Caller {
        project_id,
        thread_id: Some(thread_id.to_string()),
        grant: Grant::Owner,
        agent,
    })
}

/// A credentials file, issued for one project.
fn issued(workspace: &dyn crate::Workspace, headers: &HeaderMap) -> Result<Caller, StatusCode> {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let project_id = header_str(headers, header::PROJECT);
    if project_id.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let expected = boite_identity::project_token(workspace.secret(), project_id);
    // Constant time: a local process can call this in a loop, and a
    // byte-by-byte `!=` short-circuits, so the token reads out of the timing
    // rather than having to be guessed.
    let ok: bool = bearer.as_bytes().ct_eq(expected.as_bytes()).into();
    if !ok {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // The token proves the id was issued by this workspace. Whether the project
    // still exists is a separate question, and a file kept across a deletion
    // should read as gone rather than as a bad credential.
    let known = workspace
        .store()
        .load_projects()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .any(|p| p.id == project_id);
    if !known {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Caller {
        project_id: project_id.to_string(),
        thread_id: None,
        grant: Grant::Project,
        // Nothing to read it off, so the file is allowed to say. Checked rather
        // than taken: it ends up on a row and then in an `<img>` path.
        agent: header_str(headers, header::AGENT)
            .to_string()
            .pipe(|v| known_agent(&v)),
    })
}

/// The header, if it names an agent Boite can draw.
///
/// Checked rather than taken: the value comes from a config file the user (or
/// anything with write access to it) can edit, it ends up stored on a row and
/// then in an `<img>` path, and an unrecognised one would at best be a badge
/// nobody knows.
pub fn known_agent(value: &str) -> Option<String> {
    const KNOWN: [&str; 10] = [
        "claude",
        "codex",
        "antigravity",
        "cursor",
        "copilot",
        "opencode",
        "grok",
        "hermes",
        "pi",
        "muse",
    ];
    let value = value.trim().to_ascii_lowercase();
    KNOWN.contains(&value.as_str()).then_some(value)
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Reads left to right instead of inside out. One method, used once, because
/// the alternative is a `let` whose only job is to be the argument of the next
/// line.
trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}

impl<T> Pipe for T {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fake;
    use crate::Workspace;
    use boite_identity::ThreadKey;

    const NOW: i64 = 1_700_000_000_000;

    /// A workspace with one project and one thread in it, the thread bound to a
    /// freshly minted key.
    fn workspace(tag: &str) -> (Fake, ThreadKey) {
        let fake = Fake::new(tag).with_project("p1", "/w/one").with_thread("t1", "p1");
        let key = ThreadKey::mint();
        fake.store.bind_thread_identity("t1", &key.public_hex()).unwrap();
        (fake, key)
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        headers
    }

    /// Everything a signed request carries.
    fn signed_headers(key: &ThreadKey, thread: &str, method: &str, path: &str, body: &[u8], ts: i64) -> HeaderMap {
        let message = boite_identity::canonical(method, path, thread, ts, body);
        headers(&[
            (header::THREAD, thread),
            (header::TIMESTAMP, &ts.to_string()),
            (header::SIGNATURE, &key.sign(&message)),
        ])
    }

    #[test]
    fn a_signed_request_names_the_project_of_its_thread() {
        let (fake, key) = workspace("signed-ok");
        let caller = prove(
            &fake,
            "POST",
            "/v1/todos",
            &signed_headers(&key, "t1", "POST", "/v1/todos", b"{}", NOW),
            &Bytes::from_static(b"{}"),
            NOW,
        )
        .unwrap();
        assert_eq!(caller.project_id, "p1");
        assert_eq!(caller.thread_id.as_deref(), Some("t1"));
        assert_eq!(caller.grant, Grant::Owner);
    }

    /// The property the whole scheme is for. Presenting somebody else's thread
    /// id used to be all it took.
    #[test]
    fn a_thread_id_on_its_own_opens_nothing() {
        let (fake, _) = workspace("bare-id");
        let refused = prove(
            &fake,
            "GET",
            "/v1/todos",
            &headers(&[(header::THREAD, "t1")]),
            &Bytes::new(),
            NOW,
        );
        assert_eq!(refused.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    /// A key that is not this thread's does not open this thread.
    #[test]
    fn another_threads_key_opens_nothing() {
        let (fake, _) = workspace("wrong-key");
        let theirs = ThreadKey::mint();
        let refused = prove(
            &fake,
            "GET",
            "/v1/todos",
            &signed_headers(&theirs, "t1", "GET", "/v1/todos", b"", NOW),
            &Bytes::new(),
            NOW,
        );
        assert_eq!(refused.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    /// The signature covers the request, so one lifted off another call is not
    /// a way to make this one.
    #[test]
    fn a_signature_does_not_travel_between_requests() {
        let (fake, key) = workspace("replay-other");
        let stolen = signed_headers(&key, "t1", "GET", "/v1/todos", b"", NOW);
        for (method, path, body) in [
            ("POST", "/v1/todos", &b""[..]),
            ("GET", "/v1/projects", &b""[..]),
            ("GET", "/v1/todos", &b"{\"x\":1}"[..]),
        ] {
            let refused = prove(&fake, method, path, &stolen, &Bytes::from(body), NOW);
            assert_eq!(refused.unwrap_err(), StatusCode::UNAUTHORIZED, "{method} {path}");
        }
    }

    #[test]
    fn a_signature_goes_stale() {
        let (fake, key) = workspace("stale");
        let old = NOW - boite_identity::FRESHNESS_MS - 1;
        let refused = prove(
            &fake,
            "GET",
            "/v1/todos",
            &signed_headers(&key, "t1", "GET", "/v1/todos", b"", old),
            &Bytes::new(),
            NOW,
        );
        assert_eq!(refused.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    /// A thread from before identities existed cannot be given one by asking.
    #[test]
    fn a_thread_with_no_key_is_refused_rather_than_trusted() {
        let fake = Fake::new("legacy-thread")
            .with_project("p1", "/w/one")
            .with_thread("old", "p1");
        let key = ThreadKey::mint();
        let refused = prove(
            &fake,
            "GET",
            "/v1/todos",
            &signed_headers(&key, "old", "GET", "/v1/todos", b"", NOW),
            &Bytes::new(),
            NOW,
        );
        assert_eq!(refused.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn a_credentials_file_opens_the_project_it_was_issued_for() {
        let fake = Fake::new("issued").with_project("p1", "/w/one");
        let token = boite_identity::project_token(fake.secret(), "p1");
        let caller = prove(
            &fake,
            "GET",
            "/v1/todos",
            &headers(&[
                ("authorization", &format!("Bearer {token}")),
                (header::PROJECT, "p1"),
                (header::AGENT, "codex"),
            ]),
            &Bytes::new(),
            NOW,
        )
        .unwrap();
        assert_eq!(caller.project_id, "p1");
        assert_eq!(caller.thread_id, None);
        assert_eq!(caller.grant, Grant::Project);
        assert_eq!(caller.agent.as_deref(), Some("codex"));
    }

    /// The blocker this closes: one token that opened every project in the
    /// workspace, so an agent wired for one could edit the id in its own file
    /// and read the others.
    #[test]
    fn a_credentials_file_does_not_open_the_project_next_door() {
        let fake = Fake::new("issued-other")
            .with_project("p1", "/w/one")
            .with_project("p2", "/w/two");
        let mine = boite_identity::project_token(fake.secret(), "p1");
        let refused = prove(
            &fake,
            "GET",
            "/v1/todos",
            &headers(&[
                ("authorization", &format!("Bearer {mine}")),
                (header::PROJECT, "p2"),
            ]),
            &Bytes::new(),
            NOW,
        );
        assert_eq!(refused.unwrap_err(), StatusCode::UNAUTHORIZED);
    }

    /// And it cannot reach past the project it names, which is what stops a
    /// process Boite never launched from deciding where work happens.
    #[test]
    fn a_credentials_file_cannot_move_between_projects() {
        let caller = Caller {
            project_id: "p1".into(),
            thread_id: None,
            grant: Grant::Project,
            agent: None,
        };
        assert!(caller.ensure(Capability::ReadProject).is_ok());
        assert!(caller.ensure(Capability::MutateProject).is_ok());
        assert!(caller.ensure(Capability::MutateAcross).is_err());
        // Nor does it have a terminal for the calls that act on one.
        assert_eq!(caller.thread().unwrap_err(), StatusCode::BAD_REQUEST);
    }

    /// A working directory was the last way in that was not a credential. It is
    /// not one any more, and neither is a project named with no token.
    #[test]
    fn nothing_but_a_credential_gets_in() {
        let fake = Fake::new("no-creds").with_project("p1", "/w/one");
        for headers in [
            headers(&[]),
            headers(&[("x-boite-cwd", "/w/one")]),
            headers(&[(header::PROJECT, "p1")]),
            headers(&[("authorization", "Bearer not-a-token"), (header::PROJECT, "p1")]),
            headers(&[("authorization", "Bearer whatever")]),
        ] {
            let refused = prove(&fake, "GET", "/v1/todos", &headers, &Bytes::new(), NOW);
            assert_eq!(refused.unwrap_err(), StatusCode::UNAUTHORIZED, "{headers:?}");
        }
    }

    #[test]
    fn only_one_agent_name_per_row_is_drawable() {
        assert_eq!(known_agent(" Claude "), Some("claude".into()));
        assert_eq!(known_agent("CODEX"), Some("codex".into()));
        // Anything else lands in an <img> path nobody has an icon for.
        assert_eq!(known_agent("../../etc/passwd"), None);
        assert_eq!(known_agent(""), None);
    }
}
