use serde::{Deserialize, Serialize};

// Binary frame layout: [opcode: u8][thread uuid: 16 bytes][payload...].
pub const FRAME_OUTPUT: u8 = 0x01; // server -> client (live + raw replay)
pub const FRAME_INPUT: u8 = 0x02; // client -> server
pub const FRAME_OUTPUT_GZIP: u8 = 0x03; // server -> client, gzip-compressed replay

#[derive(Deserialize)]
pub struct Request {
    pub id: Option<u64>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Serialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(id: u64, result: serde_json::Value) -> Response {
        Response {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }
    pub fn err(id: u64, error: String) -> Response {
        Response {
            id,
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Serialize)]
pub struct Event {
    pub event: String,
    pub data: serde_json::Value,
}

impl Event {
    pub fn new(event: &str, data: serde_json::Value) -> Event {
        Event {
            event: event.to_string(),
            data,
        }
    }
}

/// Build a live binary output frame: opcode + 16-byte thread id + payload.
pub fn encode_output(thread_id: &uuid::Uuid, payload: &[u8]) -> Vec<u8> {
    encode_frame(FRAME_OUTPUT, thread_id, payload)
}

/// Build a binary frame with an explicit opcode (replay raw vs gzip).
pub fn encode_frame(op: u8, thread_id: &uuid::Uuid, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + 16 + payload.len());
    frame.push(op);
    frame.extend_from_slice(thread_id.as_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Parse an inbound binary frame into (opcode, thread uuid, payload offset).
pub fn parse_frame(bytes: &[u8]) -> Option<(u8, uuid::Uuid, &[u8])> {
    if bytes.len() < 17 {
        return None;
    }
    let opcode = bytes[0];
    let mut id = [0u8; 16];
    id.copy_from_slice(&bytes[1..17]);
    Some((opcode, uuid::Uuid::from_bytes(id), &bytes[17..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_survives_the_round_trip() {
        let id = uuid::Uuid::new_v4();
        let frame = encode_output(&id, b"hello");
        let (op, back, payload) = parse_frame(&frame).unwrap();
        assert_eq!(op, FRAME_OUTPUT);
        assert_eq!(back, id);
        assert_eq!(payload, b"hello");

        // An empty payload is a valid frame: a PTY can produce a zero-byte read
        // and the header is still seventeen bytes.
        let nothing = encode_output(&id, b"");
        let (_, _, empty) = parse_frame(&nothing).unwrap();
        assert!(empty.is_empty());
    }

    /// Anything shorter than the header is refused rather than indexed into.
    /// The bytes come off a socket, so a truncated frame is a thing that
    /// happens rather than a thing that would be a bug.
    #[test]
    fn a_frame_too_short_to_hold_a_header_is_refused() {
        assert!(parse_frame(&[]).is_none());
        assert!(parse_frame(&[FRAME_INPUT]).is_none());
        assert!(parse_frame(&[0u8; 16]).is_none());
        // Exactly the header and nothing else is valid.
        assert!(parse_frame(&[0u8; 17]).is_some());
    }

    /// The opcode is passed through rather than validated here: `ws.rs` decides
    /// what it will act on, and a frame it does not know is dropped there. This
    /// pins that the parser does not quietly rewrite it.
    #[test]
    fn the_opcode_is_reported_as_it_arrived() {
        let id = uuid::Uuid::new_v4();
        for op in [FRAME_OUTPUT, FRAME_INPUT, FRAME_OUTPUT_GZIP, 0x7f] {
            let frame = encode_frame(op, &id, b"x");
            let (back, _, _) = parse_frame(&frame).unwrap();
            assert_eq!(back, op);
        }
    }

    /// The wire shape a client parses. `result` and `error` are skipped when
    /// absent rather than sent as null: a client that checks for the key would
    /// read a null error as an error.
    #[test]
    fn a_reply_carries_one_of_the_two_and_never_both() {
        let ok = serde_json::to_value(Response::ok(1, serde_json::json!({ "a": 1 }))).unwrap();
        assert_eq!(ok["ok"], serde_json::json!(true));
        assert!(ok.get("error").is_none());

        let err = serde_json::to_value(Response::err(2, "no".into())).unwrap();
        assert_eq!(err["ok"], serde_json::json!(false));
        assert_eq!(err["error"], serde_json::json!("no"));
        assert!(err.get("result").is_none());
    }

    /// A request with no `params` is the ordinary case for the methods that
    /// take none, and must not be a parse failure.
    #[test]
    fn a_request_without_params_is_still_a_request() {
        let r: Request = serde_json::from_str(r#"{"id":1,"method":"hello"}"#).unwrap();
        assert_eq!(r.method, "hello");
        assert_eq!(r.id, Some(1));
        assert!(r.params.is_null());
    }
}
