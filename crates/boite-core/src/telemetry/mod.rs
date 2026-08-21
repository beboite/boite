//! Anonymous telemetry for a boite.
//!
//! Two independent modes:
//! - Mode A (on after onboarding, opt-out in Settings): a local random UUID
//!   is used only to deduplicate aggregate pings; usage events remain linked
//!   only by a server-side daily hash. There is no on-disk event storage.
//!   The onboarding screen no longer offers a refusal, so both of its answers
//!   land here; switching it off is a deliberate action in Settings, Privacy.
//! - Mode B (explicit consent, opt-in): local UUIDv4 `install_id` that
//!   enables retention metrics, cohorts, per-user feature distribution.
//!
//! Queue is RAM only by design, to stay outside the scope of ePrivacy art. 5(3).
//! Identifiers live in a sidecar next to `boite.db`, never in the settings
//! blob agents can read.

mod client;
mod events;
pub mod install_id;
mod platform_info;
mod queue;
mod runtime;
mod sidecar;
mod time;

pub use client::{
    export, forget, is_inert, record_consent_choice, user_agent, ConsentChoice, Mode, TELEMETRY_URL,
};
pub use events::{
    classify_thread, code_from, pane_kind_code, provider_code, sanitize_code,
    thread_kind_for_provider, Event, TelemetryContext, UpdateStage, ANIMATIONS, ERROR_CODES,
    OPERATIONS, PANE_KINDS, PROVIDERS, THEMES, THREAD_KINDS, UI_LANGUAGES, UNKNOWN_CODE,
};
pub use platform_info::{detect_arch, detect_locale, detect_os, detect_os_version};
pub use queue::{ConsentState, Handle, QueueParams, Worker};
pub use runtime::{consent_from_sidecar, context_for, TelemetryRuntime, UiState};
pub use sidecar::{path_in, Sidecar, FILE_NAME};
