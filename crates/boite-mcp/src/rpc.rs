//! The JSON-RPC engine, with both protocol eras in it.
//!
//! MCP revision 2026-07-28 removed the `initialize` handshake: a modern client
//! stamps its protocol version into every request's `_meta` and expects each
//! one answered on its own, which is what makes the protocol serverless-shaped.
//! Everything before it opens with `initialize` and negotiates once. This
//! server speaks both, per request, exactly as the specification's dual-era
//! section describes: a request carrying modern `_meta` is served statelessly,
//! an `initialize` selects legacy semantics, and neither choice is sticky
//! because nothing here ever was. The five tools answer the same either way.
//!
//! Transport stays outside. The stdio shim feeds this one line at a time; the
//! `/mcp` HTTP route feeds it one POST body at a time and additionally
//! enforces the header mirroring that transport asks for. Both read the same
//! answers back.

use serde_json::{json, Value};

/// Newest handshake revision this speaks. A legacy client asking for an older
/// one gets that one back: the shape of these tools has not changed across any
/// of them, and answering with a version the client did not offer ends the
/// handshake.
pub const LATEST_LEGACY: &str = "2025-11-25";
pub const LEGACY_PROTOCOLS: [&str; 4] =
    ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// The handshake-free revisions, which never send `initialize`.
pub const MODERN_PROTOCOLS: [&str; 1] = ["2026-07-28"];

/// The `_meta` keys revision 2026-07-28 moves the handshake into.
pub const META_PROTOCOL: &str = "io.modelcontextprotocol/protocolVersion";
pub const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

/// `UnsupportedProtocolVersionError`, from the spec's reserved range.
pub const UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;
/// `HeaderMismatchError`: HTTP transport only, defined here so both doors
/// agree on the number.
pub const HEADER_MISMATCH: i64 = -32020;
pub const METHOD_NOT_FOUND: i64 = -32601;

/// The tool list is static for the life of the process, so a client may cache
/// it for a while instead of asking again; an hour is long enough to matter
/// and short enough that a shipped update is seen the same day.
const TOOLS_TTL_MS: u64 = 3_600_000;

/// A call answering content blocks: `None` when the tool is not one of them,
/// and otherwise the array as it goes out or the sentence saying why not.
pub type BlocksCall<'a> = &'a dyn Fn(&str, &Value) -> Option<Result<Value, String>>;

/// What the engine serves: the tools, and the workspace call behind them.
///
/// `call` answers TOON text or the sentence saying why not. Everything else a
/// door might do differently, it does before or after [`answer`].
///
/// `blocks` is the exception the screenshot forced: its answer is a content
/// array, an image among them, and there is no honest `String` for that. A door
/// that can reach the browser tools passes one and `tools/call` asks it first;
/// a door that cannot passes `None` and the text pipeline is all there is.
pub struct Service<'a> {
    pub call: &'a dyn Fn(&str, &Value) -> Result<String, String>,
    pub blocks: Option<BlocksCall<'a>>,
    pub tools: Value,
    pub instructions: &'a str,
}

fn server_info() -> Value {
    json!({ "name": "boite", "version": env!("CARGO_PKG_VERSION") })
}

fn result(id: &Value, body: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": body })
}

fn error(id: &Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut err = json!({ "code": code, "message": message });
    if let Some(data) = data {
        err["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": err })
}

/// The modern protocol version a request declared, if it declared one.
///
/// The key's presence is the era: no legacy client writes it, so a request
/// carrying it is served statelessly whatever else it says.
pub fn modern_version(params: &Value) -> Option<&str> {
    params.get("_meta")?.get(META_PROTOCOL)?.as_str()
}

/// Answer in the version the legacy client asked for when it is one this
/// speaks, and in the newest one otherwise. A client that offers nothing gets
/// the newest, which is what the specification asks a server to do.
fn negotiate(params: &Value) -> &'static str {
    let asked = params.get("protocolVersion").and_then(|v| v.as_str());
    asked
        .and_then(|a| LEGACY_PROTOCOLS.into_iter().find(|s| *s == a))
        .unwrap_or(LATEST_LEGACY)
}

/// Stamps what revision 2026-07-28 requires onto a result.
///
/// Only onto a modern request's result: the fields are harmless to most older
/// clients, but "most" is not a contract, and a legacy client already got the
/// exact shape its revision promised it.
fn modernize(mut body: Value, cacheable: bool) -> Value {
    body["resultType"] = json!("complete");
    body["_meta"] = json!({ META_SERVER_INFO: server_info() });
    if cacheable {
        body["ttlMs"] = json!(TOOLS_TTL_MS);
        // Private: the list is the same for everyone today, but the answer
        // rides on an authenticated request and a shared cache has no business
        // holding it.
        body["cacheScope"] = json!("private");
    }
    body
}

fn unsupported(id: &Value, requested: &str) -> Value {
    error(
        id,
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version",
        Some(json!({ "supported": MODERN_PROTOCOLS, "requested": requested })),
    )
}

/// One message in, at most one answer out.
///
/// `None` is a notification: it carries no id and expects nothing back. Tool
/// failures come back as a result with `isError`, not as a JSON-RPC error:
/// the call reached the tool and the agent should read what went wrong and
/// adapt. Protocol-level errors are a different thing and stay rare.
pub fn answer(service: &Service, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let id = msg.get("id").cloned()?;
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    // The era check runs before the method does anything: a modern client on a
    // revision this does not speak is told which ones it does, and retries.
    let modern = match modern_version(&params) {
        Some(v) if !MODERN_PROTOCOLS.contains(&v) => return Some(unsupported(&id, v)),
        Some(_) => true,
        None => false,
    };

    Some(match method {
        // The modern probe. Servers MUST implement it, and it doubles as the
        // stdio backward-compatibility check: a legacy server answers it with
        // an error, which is exactly what tells the client to fall back.
        "server/discover" => result(
            &id,
            modernize(
                json!({
                    "supportedVersions": MODERN_PROTOCOLS,
                    "capabilities": { "tools": {} },
                    "instructions": service.instructions,
                }),
                true,
            ),
        ),
        // The legacy handshake, kept whole: a client that opens with it is
        // served the revision it negotiates, on this and every later call.
        "initialize" => result(
            &id,
            json!({
                "protocolVersion": negotiate(&params),
                "capabilities": { "tools": {} },
                "serverInfo": server_info(),
                "instructions": service.instructions
            }),
        ),
        "tools/list" => {
            let body = json!({ "tools": service.tools });
            result(&id, if modern { modernize(body, true) } else { body })
        }
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            // The blocks hook owns the few tools whose answer is not text, and
            // says so by answering `Some`. Everything else, itself included
            // when it has nothing to say, falls through to the text pipeline,
            // and both eras dress the result the same way afterwards.
            let answered = service
                .blocks
                .and_then(|blocks| blocks(name, &args))
                .map(|out| out.map(|content| json!({ "content": content })));
            let body = match answered {
                Some(Ok(body)) => body,
                Some(Err(e)) => {
                    json!({ "content": [{ "type": "text", "text": e }], "isError": true })
                }
                None => match (service.call)(name, &args) {
                    Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                    Err(e) => {
                        json!({ "content": [{ "type": "text", "text": e }], "isError": true })
                    }
                },
            };
            result(&id, if modern { modernize(body, false) } else { body })
        }
        // Legacy only; revision 2026-07-28 removed it and a modern client
        // never sends one. Answering anyway costs a line.
        "ping" => result(&id, json!({})),
        other => error(&id, METHOD_NOT_FOUND, &format!("method not found: {other}"), None),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str, _args: &Value) -> Result<String, String> {
        match name {
            "works" => Ok("done".into()),
            other => Err(format!("unknown tool: {other}")),
        }
    }

    fn service(tools: &'static Value) -> Service<'static> {
        Service {
            call: &call,
            blocks: None,
            tools: tools.clone(),
            instructions: "use the tools",
        }
    }

    /// A door that can answer in blocks, for the tool that does.
    fn service_with_blocks(tools: &'static Value) -> Service<'static> {
        fn blocks(name: &str, _args: &Value) -> Option<Result<Value, String>> {
            match name {
                "shot" => Some(Ok(json!([{ "type": "image", "data": "iVBOR" }]))),
                "broken_shot" => Some(Err("the device answered without an image".into())),
                _ => None,
            }
        }
        Service {
            call: &call,
            blocks: Some(&blocks),
            tools: tools.clone(),
            instructions: "use the tools",
        }
    }

    fn tools() -> &'static Value {
        use std::sync::OnceLock;
        static TOOLS: OnceLock<Value> = OnceLock::new();
        TOOLS.get_or_init(|| json!([{ "name": "works" }]))
    }

    fn modern(method: &str, extra: Value) -> Value {
        let mut params = json!({ "_meta": { META_PROTOCOL: "2026-07-28" } });
        if let (Some(base), Some(more)) = (params.as_object_mut(), extra.as_object()) {
            for (k, v) in more {
                base.insert(k.clone(), v.clone());
            }
        }
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
    }

    /// Answering with a version the client did not offer ends the handshake,
    /// so an older client gets the version it asked for rather than the
    /// newest.
    #[test]
    fn the_legacy_handshake_answers_what_the_client_offered() {
        assert_eq!(negotiate(&json!({ "protocolVersion": "2024-11-05" })), "2024-11-05");
        assert_eq!(negotiate(&json!({ "protocolVersion": "1999-01-01" })), LATEST_LEGACY);
        assert_eq!(negotiate(&json!({})), LATEST_LEGACY);
    }

    /// The probe every modern client may open with, and the one method the
    /// spec says a server of this revision has no choice about.
    #[test]
    fn discover_names_the_modern_versions_and_the_tools() {
        let out = answer(
            &service(tools()),
            &json!({ "jsonrpc": "2.0", "id": 7, "method": "server/discover", "params": {} }),
        )
        .unwrap();
        let body = &out["result"];
        assert_eq!(body["supportedVersions"], json!(MODERN_PROTOCOLS));
        assert_eq!(body["resultType"], "complete");
        assert_eq!(body["capabilities"]["tools"], json!({}));
        assert_eq!(body["_meta"][META_SERVER_INFO]["name"], "boite");
        assert!(body["ttlMs"].is_u64() && body["cacheScope"] == "private");
    }

    /// A revision this does not speak is told which ones it does, with the
    /// spec's own error code, so the client retries instead of falling back.
    #[test]
    fn an_unknown_modern_version_is_told_the_supported_list() {
        let mut msg = modern("tools/list", json!({}));
        msg["params"]["_meta"][META_PROTOCOL] = json!("2099-01-01");
        let out = answer(&service(tools()), &msg).unwrap();
        assert_eq!(out["error"]["code"], UNSUPPORTED_PROTOCOL_VERSION);
        assert_eq!(out["error"]["data"]["supported"], json!(MODERN_PROTOCOLS));
        assert_eq!(out["error"]["data"]["requested"], "2099-01-01");
    }

    /// The same list, dressed per era: a modern result carries `resultType`
    /// and the caching fields, a legacy one stays exactly what its revision
    /// promised.
    #[test]
    fn the_tool_list_is_dressed_for_the_era_that_asked() {
        let svc = service(tools());
        let legacy = answer(
            &svc,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }),
        )
        .unwrap();
        assert!(legacy["result"].get("resultType").is_none());
        assert!(legacy["result"].get("ttlMs").is_none());

        let modern = answer(&svc, &modern("tools/list", json!({}))).unwrap();
        assert_eq!(modern["result"]["resultType"], "complete");
        assert!(modern["result"]["ttlMs"].is_u64());
        assert_eq!(modern["result"]["tools"], legacy["result"]["tools"]);
    }

    /// A tool failure is a result the agent reads, never a protocol error,
    /// in either era.
    #[test]
    fn a_tool_failure_stays_a_readable_result() {
        let svc = service(tools());
        let out = answer(
            &svc,
            &modern("tools/call", json!({ "name": "missing", "arguments": {} })),
        )
        .unwrap();
        assert_eq!(out["result"]["isError"], true);
        assert_eq!(out["result"]["resultType"], "complete");

        let ok = answer(&svc, &modern("tools/call", json!({ "name": "works" }))).unwrap();
        assert_eq!(ok["result"]["content"][0]["text"], "done");
    }

    /// The screenshot answers content blocks rather than text, and everything
    /// the blocks hook has nothing to say about still falls through to the
    /// text pipeline. A modern result is dressed the same either way.
    #[test]
    fn a_blocks_answer_goes_out_whole_and_the_rest_falls_through() {
        let svc = service_with_blocks(tools());

        let shot = answer(&svc, &modern("tools/call", json!({ "name": "shot" }))).unwrap();
        assert_eq!(shot["result"]["content"][0]["type"], "image");
        assert!(shot["result"].get("isError").is_none());
        assert_eq!(shot["result"]["resultType"], "complete");

        let broken =
            answer(&svc, &modern("tools/call", json!({ "name": "broken_shot" }))).unwrap();
        assert_eq!(broken["result"]["isError"], true);
        assert_eq!(broken["result"]["resultType"], "complete");

        let text = answer(&svc, &modern("tools/call", json!({ "name": "works" }))).unwrap();
        assert_eq!(text["result"]["content"][0]["text"], "done");
    }

    /// Notifications carry no id and expect no answer.
    #[test]
    fn a_notification_is_answered_with_silence() {
        let out = answer(
            &service(tools()),
            &json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": {} }),
        );
        assert!(out.is_none());
    }
}
