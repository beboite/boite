//! The wire to `tauri-plugin-mcp-bridge` 0.12.0, pinned against its source.
//!
//! What the plugin does, read off the crate rather than guessed:
//!
//! - It binds a WebSocket server. Its own default is `0.0.0.0:9223`; boite
//!   passes `bind_address("127.0.0.1")`, and `discovery::find_available_port`
//!   then walks `base_port..base_port + 100`, taking the first port it can
//!   bind. So the dev window's bridge is somewhere in **9223 to 9322** and
//!   the port is published nowhere: it is logged and dropped. A client scans.
//! - One text frame in, one text frame out, matched by an `id` the client
//!   chooses. A request is `{"id", "command", "args"}` and an answer is
//!   `{"id", "success", "data"?, "error"?}` (plus `windowContext` on the two
//!   commands that resolve a window).
//! - The verbs `dispatch_command` answers, all of them:
//!   `list_windows`, `get_window_info`, `execute_js`,
//!   `capture_native_screenshot`, `resize_window`, `register_script`,
//!   `remove_script`, `clear_scripts`, `get_scripts`, and `invoke_tauri`,
//!   which proxies nine of the plugin's own IPC commands and nothing else.
//! - `execute_js` wraps the script in an async function, so `return` works and
//!   a promise is awaited. Its `data` is the returned value as JSON.
//! - `capture_native_screenshot` answers a **base64 data URL**, PNG by
//!   default, captured from WebView2's `CapturePreview`: the viewport only.
//!
//! The client is written by hand over a blocking `TcpStream` for the same
//! reason `http.rs` exists: this binary is spawned once per agent session and
//! a WebSocket crate would bring an async runtime with it. Framing is RFC 6455
//! with the two halves that matter on loopback, a masked client frame out and
//! an unmasked server frame in.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

use serde_json::{json, Value};

/// The plugin's `base_port`, and the hundred ports its discovery walks.
pub const BASE_PORT: u16 = 9223;
pub const PORT_SPAN: u16 = 100;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
/// Generous on purpose: `execute_js` on the eval-and-IPC path waits for the
/// webview to come back through a Tauri event, and a screenshot encodes a PNG.
const IO_TIMEOUT: Duration = Duration::from_secs(20);
/// A frame larger than this is a bug on our side, not a screenshot: the
/// biggest honest payload is a data URL of a 1280x800 PNG.
const MAX_FRAME: usize = 64 * 1024 * 1024;

/// One request, in the shape `dispatch_command` reads.
///
/// Separated from the socket so the encoding can be tested without a window:
/// the field names here are the contract, and a rename in the plugin shows up
/// as a failing test rather than as a silent "Unknown command".
pub fn encode_command(id: &str, command: &str, args: Value) -> Value {
    json!({ "id": id, "command": command, "args": args })
}

/// The `data` of an answer, or the sentence the bridge refused with.
///
/// `success` is authoritative even when `error` is null, and an `error` with
/// no `success: false` has never been observed; both are read anyway, because
/// a refusal reported as an empty success is the one failure mode an agent
/// cannot diagnose.
pub fn decode_response(reply: &Value) -> Result<Value, String> {
    if reply.get("success").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(reply.get("data").cloned().unwrap_or(Value::Null));
    }
    let message = reply
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("the bridge refused without saying why");
    Err(message.to_string())
}

/// A base64 data URL split into its media type and its bytes.
///
/// The screenshot arrives as `data:image/png;base64,<...>`; anything else is
/// the plugin having changed shape, and is reported rather than written to a
/// file that would not open.
pub fn decode_data_url(url: &str) -> Result<(String, Vec<u8>), String> {
    let rest = url
        .strip_prefix("data:")
        .ok_or("the bridge answered something that is not a data url")?;
    let (meta, payload) = rest
        .split_once(',')
        .ok_or("the bridge answered a data url with no payload")?;
    let media = meta.trim_end_matches(";base64").to_string();
    if !meta.ends_with(";base64") {
        return Err(format!("the bridge answered a {media} url that is not base64"));
    }
    let bytes = base64_decode(payload)?;
    Ok((media, bytes))
}

/// An open connection to one bridge.
pub struct Bridge {
    stream: TcpStream,
    port: u16,
    next_id: u64,
}

impl Bridge {
    /// Connect to a bridge on `port` and complete the WebSocket handshake.
    pub fn connect(port: u16) -> Result<Bridge, String> {
        let addr = format!("127.0.0.1:{port}")
            .parse()
            .map_err(|e| format!("bad bridge address: {e}"))?;
        let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
            .map_err(|e| format!("no bridge on {port}: {e}"))?;
        stream.set_nodelay(true).ok();
        stream
            .set_read_timeout(Some(IO_TIMEOUT))
            .map_err(|e| format!("bridge socket: {e}"))?;
        stream
            .set_write_timeout(Some(IO_TIMEOUT))
            .map_err(|e| format!("bridge socket: {e}"))?;
        let mut bridge = Bridge {
            stream,
            port,
            next_id: 1,
        };
        bridge.handshake()?;
        Ok(bridge)
    }

    /// Find the dev window's bridge by walking the discovery range.
    ///
    /// Another Tauri app with this plugin would answer too, so the window is
    /// identified rather than assumed: `list_windows` carries every window's
    /// title, and the dev window's is the isolated config's `productName`.
    /// A release boite never has a bridge at all, the plugin being behind
    /// `debug_assertions` and a feature.
    pub fn discover(title: &str) -> Result<Bridge, String> {
        let mut last = String::from("nothing answered on 9223-9322");
        for port in BASE_PORT..BASE_PORT + PORT_SPAN {
            let Ok(mut bridge) = Bridge::connect(port) else {
                continue;
            };
            match bridge.call("list_windows", json!({})) {
                Ok(data) if windows_titled(&data, title) => return Ok(bridge),
                Ok(_) => last = format!("a bridge answers on {port}, but no window is \"{title}\""),
                Err(e) => last = format!("the bridge on {port} refused: {e}"),
            }
        }
        Err(last)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// One request, one answer. Frames that are not the answer (a broadcast
    /// event, a ping) are consumed until the id matches: the plugin pushes
    /// element-picker events onto the same socket.
    pub fn call(&mut self, command: &str, args: Value) -> Result<Value, String> {
        let id = format!("boite-{}", self.next_id);
        self.next_id += 1;
        let request = encode_command(&id, command, args);
        self.send_text(&request.to_string())?;
        loop {
            let text = self.read_text()?;
            let Ok(reply) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if reply.get("id").and_then(|v| v.as_str()) != Some(id.as_str()) {
                continue;
            }
            return decode_response(&reply);
        }
    }

    /// Run JavaScript in the dev window and answer what it returned.
    ///
    /// The plugin wraps the script in an async function body, so a `return` is
    /// required and an `await` is allowed.
    pub fn execute_js(&mut self, script: &str) -> Result<Value, String> {
        self.call("execute_js", json!({ "script": script }))
    }

    /// The viewport as PNG bytes, decoded from the data URL the plugin sends.
    pub fn screenshot(&mut self, max_width: Option<u32>) -> Result<Vec<u8>, String> {
        let mut args = json!({ "format": "png" });
        if let Some(width) = max_width {
            args["maxWidth"] = json!(width);
        }
        let data = self.call("capture_native_screenshot", args)?;
        let url = data
            .as_str()
            .ok_or("the bridge answered a screenshot that is not a string")?;
        let (_, bytes) = decode_data_url(url)?;
        Ok(bytes)
    }

    fn handshake(&mut self) -> Result<(), String> {
        // The key exists to keep a caching proxy from replaying a handshake,
        // and there is no proxy on loopback, so it is derived from the clock
        // rather than from a random source this binary does not otherwise
        // link. The server's `Sec-WebSocket-Accept` is not checked back for
        // the same reason: nothing is in the middle.
        let nonce = crate::now_ms() as u64;
        let mut raw = [0u8; 16];
        raw[..8].copy_from_slice(&nonce.to_le_bytes());
        raw[8..].copy_from_slice(&(nonce.rotate_left(17)).to_be_bytes());
        let key = base64_encode(&raw);
        let request = format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            self.port
        );
        self.stream
            .write_all(request.as_bytes())
            .map_err(|e| format!("bridge handshake: {e}"))?;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            let read = self
                .stream
                .read(&mut byte)
                .map_err(|e| format!("bridge handshake: {e}"))?;
            if read == 0 {
                return Err("the bridge closed during the handshake".into());
            }
            head.push(byte[0]);
            if head.len() > 8192 {
                return Err("the bridge sent an oversized handshake".into());
            }
        }
        let text = String::from_utf8_lossy(&head);
        if !text.starts_with("HTTP/1.1 101") {
            let status = text.lines().next().unwrap_or("").to_string();
            return Err(format!("the bridge refused the upgrade: {status}"));
        }
        Ok(())
    }

    fn send_text(&mut self, text: &str) -> Result<(), String> {
        let payload = text.as_bytes();
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x81); // FIN, opcode 1 (text)
        let mask_bit = 0x80u8;
        match payload.len() {
            n if n < 126 => frame.push(mask_bit | n as u8),
            n if n <= u16::MAX as usize => {
                frame.push(mask_bit | 126);
                frame.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                frame.push(mask_bit | 127);
                frame.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        // A client frame must be masked; the value only has to be
        // unpredictable to a proxy, and there is none here.
        let mask = (crate::now_ms() as u32).to_be_bytes();
        frame.extend_from_slice(&mask);
        for (i, byte) in payload.iter().enumerate() {
            frame.push(byte ^ mask[i % 4]);
        }
        self.stream
            .write_all(&frame)
            .map_err(|e| format!("bridge write: {e}"))?;
        self.stream
            .flush()
            .map_err(|e| format!("bridge write: {e}"))
    }

    /// The next text message, reassembling continuation frames and answering
    /// a ping so a long `execute_js` does not lose the connection.
    fn read_text(&mut self) -> Result<String, String> {
        let mut message = Vec::new();
        loop {
            let (fin, opcode, payload) = self.read_frame()?;
            match opcode {
                // Continuation, text, binary: all three carry message bytes.
                0x0..=0x2 => {
                    message.extend_from_slice(&payload);
                    if fin {
                        return String::from_utf8(message)
                            .map_err(|_| "the bridge sent a frame that is not utf-8".to_string());
                    }
                }
                0x8 => return Err("the bridge closed the connection".into()),
                0x9 => self.send_pong(&payload)?,
                _ => {}
            }
        }
    }

    fn read_frame(&mut self) -> Result<(bool, u8, Vec<u8>), String> {
        let mut head = [0u8; 2];
        self.read_exact(&mut head)?;
        let fin = head[0] & 0x80 != 0;
        let opcode = head[0] & 0x0f;
        let masked = head[1] & 0x80 != 0;
        let length = match head[1] & 0x7f {
            126 => {
                let mut n = [0u8; 2];
                self.read_exact(&mut n)?;
                u16::from_be_bytes(n) as usize
            }
            127 => {
                let mut n = [0u8; 8];
                self.read_exact(&mut n)?;
                u64::from_be_bytes(n) as usize
            }
            n => n as usize,
        };
        if length > MAX_FRAME {
            return Err(format!("the bridge sent a {length} byte frame"));
        }
        let mask = if masked {
            let mut m = [0u8; 4];
            self.read_exact(&mut m)?;
            Some(m)
        } else {
            None
        };
        let mut payload = vec![0u8; length];
        self.read_exact(&mut payload)?;
        if let Some(mask) = mask {
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[i % 4];
            }
        }
        Ok((fin, opcode, payload))
    }

    fn send_pong(&mut self, payload: &[u8]) -> Result<(), String> {
        let mut frame = vec![0x8a, 0x80 | payload.len() as u8];
        let mask = (crate::now_ms() as u32).to_be_bytes();
        frame.extend_from_slice(&mask);
        for (i, byte) in payload.iter().enumerate() {
            frame.push(byte ^ mask[i % 4]);
        }
        self.stream
            .write_all(&frame)
            .map_err(|e| format!("bridge write: {e}"))
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> Result<(), String> {
        self.stream
            .read_exact(buf)
            .map_err(|e| format!("bridge read: {e}"))
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

/// Whether `list_windows` answered a window with this title.
///
/// Its `data` is a **bare array** of `{label, title, url, visible, focused,
/// isMain}`, not an object wrapping one. Both shapes are read because the
/// wrapped one is the obvious guess and cost a run to disprove; a version that
/// wrapped it would otherwise report every window as absent.
pub fn windows_titled(data: &Value, title: &str) -> bool {
    let windows = data
        .as_array()
        .or_else(|| data.get("windows").and_then(|v| v.as_array()));
    let Some(windows) = windows else {
        return false;
    };
    windows.iter().any(|w| {
        w.get("title")
            .and_then(|v| v.as_str())
            .is_some_and(|t| t.contains(title))
    })
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|e| format!("the bridge sent base64 that does not decode: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_carries_the_three_fields_the_plugin_reads() {
        let encoded = encode_command("boite-1", "execute_js", json!({ "script": "return 1" }));
        assert_eq!(encoded["id"], "boite-1");
        assert_eq!(encoded["command"], "execute_js");
        assert_eq!(encoded["args"]["script"], "return 1");
    }

    #[test]
    fn a_success_answers_its_data_and_a_failure_its_sentence() {
        let ok = json!({ "id": "boite-1", "success": true, "data": { "view": "home" } });
        assert_eq!(decode_response(&ok).expect("data")["view"], "home");
        let refused = json!({ "id": "boite-1", "success": false, "error": "Missing script argument" });
        assert_eq!(
            decode_response(&refused).expect_err("refusal"),
            "Missing script argument"
        );
    }

    // The plugin sends `success: false` with a null `data` for a script that
    // threw, and the sentence is the only thing in the frame worth reading.
    #[test]
    fn a_thrown_script_is_a_refusal_and_not_an_empty_answer() {
        let threw = json!({
            "id": "boite-2",
            "success": false,
            "data": null,
            "error": "window.__boite is undefined",
            "windowContext": { "windowLabel": "main", "totalWindows": 1 }
        });
        assert_eq!(
            decode_response(&threw).expect_err("refusal"),
            "window.__boite is undefined"
        );
    }

    #[test]
    fn a_screenshot_is_a_base64_png_data_url() {
        // The eight bytes of a PNG signature, which is what a real answer
        // starts with once decoded.
        let url = "data:image/png;base64,iVBORw0KGgo=";
        let (media, bytes) = decode_data_url(url).expect("decoded");
        assert_eq!(media, "image/png");
        assert_eq!(bytes, vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    #[test]
    fn a_data_url_that_is_not_base64_is_refused_rather_than_written_out() {
        assert!(decode_data_url("data:image/png,notbase64").is_err());
        assert!(decode_data_url("iVBORw0KGgo=").is_err());
    }

    /// The record is the one 0.12.0 really sends, copied off the wire rather
    /// than written from the struct: `data` is a bare array, which is what the
    /// first live run got wrong.
    #[test]
    fn the_dev_window_is_recognised_in_the_shape_the_plugin_sends() {
        let listed = json!([{
            "focused": false,
            "isMain": true,
            "label": "main",
            "title": "Boite Dev",
            "url": "http://localhost:1430/",
            "visible": true
        }]);
        assert!(windows_titled(&listed, "Boite Dev"));
        let other = json!([{ "label": "main", "title": "Some Other App" }]);
        assert!(!windows_titled(&other, "Boite Dev"));
        assert!(!windows_titled(&json!({}), "Boite Dev"));
    }

    /// A version that wrapped the array would otherwise report every window as
    /// absent, and the failure reads as "the window is not up".
    #[test]
    fn a_wrapped_array_is_read_as_well() {
        let listed = json!({ "windows": [{ "label": "main", "title": "Boite Dev" }] });
        assert!(windows_titled(&listed, "Boite Dev"));
    }

    #[test]
    fn the_discovery_range_is_the_plugins_own() {
        assert_eq!(BASE_PORT, 9223);
        assert_eq!(BASE_PORT + PORT_SPAN - 1, 9322);
    }
}
