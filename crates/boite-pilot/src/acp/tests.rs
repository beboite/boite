use serde_json::json;

use super::*;

fn options() -> Vec<NativePermission> {
    vec![
        NativePermission {
            option_id: "once-native".into(),
            kind: "allow_once".into(),
        },
        NativePermission {
            option_id: "always-native".into(),
            kind: "allow_always".into(),
        },
        NativePermission {
            option_id: "reject-native".into(),
            kind: "reject_once".into(),
        },
    ]
}

#[test]
fn permission_selection_returns_the_agents_opaque_id() {
    let (result, outcome) = permission_answer(&options(), Some("always-native"), false, true);
    assert_eq!(outcome, RequestOutcome::Allowed);
    assert_eq!(
        result,
        json!({ "outcome": { "outcome": "selected", "optionId": "always-native" } })
    );
}

#[test]
fn semantic_session_allow_prefers_allow_always() {
    let (result, outcome) = permission_answer(&options(), None, true, true);
    assert_eq!(outcome, RequestOutcome::Allowed);
    assert_eq!(result["outcome"]["optionId"], "always-native");
}

#[test]
fn missing_reject_option_cancels_instead_of_allowing() {
    let allow_only = &options()[..2];
    let (result, outcome) = permission_answer(allow_only, None, false, false);
    assert_eq!(outcome, RequestOutcome::Cancelled);
    assert_eq!(result["outcome"]["outcome"], "cancelled");
}
