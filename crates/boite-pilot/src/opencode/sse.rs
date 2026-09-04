//! Decode complete SSE lines, not HTTP chunks that can split UTF-8 characters.
use crate::driver::PilotError;
use serde_json::Value;

const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Decoder {
    line: Vec<u8>,
    data: String,
    skip_lf: bool,
}

impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, PilotError> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\n' || byte == b'\r' {
                self.finish_line(&mut events)?;
                self.skip_lf = byte == b'\r';
            } else {
                if self.line.len() + self.data.len() >= MAX_EVENT_BYTES {
                    return Err(PilotError::Protocol(
                        "OpenCode SSE event exceeds 4 MiB".into(),
                    ));
                }
                self.line.push(byte);
            }
        }
        Ok(events)
    }

    fn finish_line(&mut self, events: &mut Vec<Value>) -> Result<(), PilotError> {
        if self.line.is_empty() {
            if !self.data.is_empty() {
                let event =
                    serde_json::from_str(self.data.trim_end_matches('\n')).map_err(|error| {
                        PilotError::Protocol(format!("invalid OpenCode SSE event: {error}"))
                    })?;
                events.push(event);
                self.data.clear();
            }
        } else {
            let line = std::str::from_utf8(&self.line)
                .map_err(|_| PilotError::Protocol("OpenCode SSE line is not UTF-8".into()))?;
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            if field == "data" {
                self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
                self.data.push('\n');
            }
            self.line.clear();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_utf8_and_crlf_split_is_lossless() {
        let frame = "data: {\"text\":\"été 🦀\"}\r\n\r\n".as_bytes();
        for split in 0..=frame.len() {
            let mut decoder = Decoder::default();
            let mut events = decoder.push(&frame[..split]).unwrap();
            events.extend(decoder.push(&frame[split..]).unwrap());
            assert_eq!(events, [json!({ "text": "été 🦀" })], "split {split}");
        }
    }

    #[test]
    fn multiline_comments_multiple_events_and_cr_only() {
        assert_eq!(
            Decoder::default()
                .push(b": heartbeat\rdata: {\rdata: \"n\":1}\r\rdata: {}\n\n")
                .unwrap(),
            [json!({"n": 1}), json!({})]
        );
    }

    #[test]
    fn incomplete_events_are_not_emitted() {
        let mut decoder = Decoder::default();
        assert!(decoder.push(b"data: {}").unwrap().is_empty());
        assert!(decoder.push(b"\n").unwrap().is_empty());
        assert_eq!(decoder.push(b"\n").unwrap(), [json!({})]);
    }

    #[test]
    fn rejects_invalid_utf8_and_oversized_lines() {
        assert!(Decoder::default().push(b"data: \xff\n").is_err());
        assert!(Decoder::default()
            .push(&vec![b'x'; MAX_EVENT_BYTES + 1])
            .is_err());
    }

    #[test]
    fn bounds_multiline_event_not_only_each_line() {
        let mut decoder = Decoder::default();
        let line = format!("data: {}\n", " ".repeat(1024));
        let mut rejected = false;
        for _ in 0..MAX_EVENT_BYTES / 1024 + 1 {
            if decoder.push(line.as_bytes()).is_err() {
                rejected = true;
                break;
            }
        }
        assert!(rejected);
    }
}
