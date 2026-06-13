use serde::{Deserialize, Serialize};

// Binary frame layout: [opcode: u8][thread uuid: 16 bytes][payload...].
pub const FRAME_OUTPUT: u8 = 0x01; // server -> client (live + replay)
pub const FRAME_INPUT: u8 = 0x02; // client -> server

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

/// Build a binary output frame: opcode + 16-byte thread id + payload.
pub fn encode_output(thread_id: &uuid::Uuid, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + 16 + payload.len());
    frame.push(FRAME_OUTPUT);
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
