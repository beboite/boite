const SECRET_FLAGS = new Set([
  "--api-key",
  "--apikey",
  "--api_key",
  "--token",
  "--auth-token",
  "--secret",
  "--password",
  "--pass",
  "--key",
  "--access-token",
  "--bearer",
  "--client-secret",
  "--anthropic-api-key",
  "--openai-api-key",
  "-p",
  "-k",
]);

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
