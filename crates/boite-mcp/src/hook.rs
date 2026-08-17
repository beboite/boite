//! The Stop hook's stdout, from the finish body.
//!
//! Kept out of `main` so the decision can be tested without a socket. Exit
//! code is always 0: a hook that errors is read as "carry on", and the
//! block lives in the JSON when there is one.

use serde_json::{json, Value};

/// What to print, or `None` when the turn may stop.
pub fn stop_output(already_active: bool, finish: &Value) -> Option<String> {
    if already_active {
        return None;
    }
    if finish.get("allow").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    let reason = finish
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("this worktree would lose work if the turn ended now");
    let keep = finish.get("keep").and_then(Value::as_str);
    let text = match keep {
        Some(tool) => format!("{reason}. Call {tool} to keep it."),
        None => reason.to_string(),
    };
    Some(
        json!({
            "decision": "block",
            "reason": text
        })
        .to_string(),
    )
}

/// Claude's `stop_hook_active` on the hook stdin payload.
pub fn stop_already_active(input: &str) -> bool {
    serde_json::from_str::<Value>(input)
        .ok()
        .and_then(|v| v.get("stop_hook_active").and_then(Value::as_bool))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_pass_prints_nothing() {
        let body = json!({ "allow": false, "reason": "dirty", "keep": "worktree_branch" });
        assert_eq!(stop_output(true, &body), None);
    }

    #[test]
    fn an_allow_prints_nothing() {
        assert_eq!(stop_output(false, &json!({ "allow": true })), None);
        assert_eq!(stop_output(false, &json!({})), None);
    }

    #[test]
    fn a_block_names_the_tool() {
        let text = stop_output(
            false,
            &json!({
                "allow": false,
                "reason": "this worktree has uncommitted changes",
                "keep": "worktree_branch"
            }),
        )
        .unwrap();
        assert!(text.contains("\"decision\":\"block\""), "{text}");
        assert!(text.contains("worktree_branch"), "{text}");
        assert!(text.contains("uncommitted"), "{text}");
    }

    #[test]
    fn stdin_stop_hook_active_is_read() {
        assert!(stop_already_active(r#"{"stop_hook_active":true}"#));
        assert!(!stop_already_active(r#"{"stop_hook_active":false}"#));
        assert!(!stop_already_active(""));
        assert!(!stop_already_active("not json"));
    }
}
