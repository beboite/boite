const SECRET_FLAGS = new Set([
  "--api-key",
  "--apikey",
  "--api_key",
  "--token",
  "--auth-token",
  "--secret",
  "--password",
  "--pass",
  "--access-token",
  "--bearer",
  "--client-secret",
  "--anthropic-api-key",
  "--openai-api-key",
  "-k",
]);

// Two flags that used to sit in that list and never carried a value worth
// hiding, on any command this app spawns:
//
// - `--key` is how fastpick names *which* credential to launch on, written
//   `<provider>.<key>` (`comboArgs` writes it itself). It is an identifier, not
//   a secret, and redacting it relaunched the thread as
//   `fastpick --key *** …`, which fastpick answers with
//   `no provider or key with id '***', see --list`.
// - `-p` is the prompt flag of claude, codex and fastpick alike, so a thread
//   carrying `-- -p "<prompt>"` came back with `***` as its prompt.
//
// A real secret handed to either one is still caught: SECRET_VALUE_RE tests
// every argument whatever flag precedes it.

// Anchored on each provider's real separator, not on the bare prefix. `sk`
// and `ghp` alone matched ordinary words ("skip", "ghost"), and because these
// args are persisted and replayed when a thread respawns, a false positive
// did not just hide a value — it relaunched the command with `***` in it.
const SECRET_VALUE_RE =
  /^(?:(?:sk|pk)[-_]|(?:ghp|gho|ghu|ghs|ghr)_|xox[abposr]-|AIza[\w-]{10,}|ya29\.|AKIA[0-9A-Z]{16})/;

export const REDACTED = "***";

export function redactArgs(args: string[]): { args: string[]; redacted: boolean } {
  const out: string[] = [];
  let redacted = false;
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      out.push(REDACTED);
      skipNext = false;
      redacted = true;
      continue;
    }
    const lowered = a.toLowerCase();
    if (SECRET_FLAGS.has(lowered)) {
      out.push(a);
      skipNext = true;
      continue;
    }
    const eqIdx = a.indexOf("=");
    if (eqIdx > 0) {
      const key = a.slice(0, eqIdx).toLowerCase();
      if (SECRET_FLAGS.has(key)) {
        out.push(`${a.slice(0, eqIdx)}=${REDACTED}`);
        redacted = true;
        continue;
      }
    }
    if (SECRET_VALUE_RE.test(a)) {
      out.push(REDACTED);
      redacted = true;
      continue;
    }
    out.push(a);
  }
  return { args: out, redacted };
}
