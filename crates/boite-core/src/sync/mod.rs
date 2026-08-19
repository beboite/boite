//! Carrying an agent's configuration from one computer to another.
//!
//! Working on two machines with the same agents means setting the same things
//! up twice: the default model, the plugins, the MCP servers, and above all the
//! shared instruction tree in `~/.agents`. None of it follows. This module makes
//! it follow, through a private git repository the user owns and points Boite
//! at — no Boite server, no account, and no credential stored here: git resolves
//! authentication on the machine the threads run on, exactly as it does for
//! every other repository there.
//!
//! Four rules hold the design together, and each one ships broken if forgotten.
//!
//! **The manifest is an allowlist of named files plus one tree**, never a
//! directory minus a denylist. `~/.claude` is not a source; `~/.claude/settings.json`
//! is. See `manifest`.
//!
//! **A file is parsed only if it declares a field rule, and it is never written
//! back.** `serde_json` here has no `preserve_order` and one file in scope is
//! JSONC. Redaction substitutes a value's own text; it does not rewrite a
//! document. See `portable`.
//!
//! **A secret never leaves.** A credential inside a file that is in scope — and
//! there is one — is swapped for a placeholder keyed on the field it came from,
//! so two machines produce identical bytes and a pull restores what was already
//! here rather than blanking it.
//!
//! **A difference is never overwritten.** What differs on both sides goes to a
//! merge tool that can keep both, the first sync on a machine that already has
//! configuration included.

pub mod apply;
pub mod home;
pub mod manifest;
pub mod portable;
pub mod scan;
