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

const SECRET_VALUE_RE =
  /^(sk|pk|ghp|gho|ghu|ghs|ghr|xox[abposr]|AIza|ya29\.|AKIA[0-9A-Z]{16})/;

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
