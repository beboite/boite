/**
 * The echo provider's login: what an OAuth CLI does, without a browser and
 * without a network. It prints a link, waits for one line on stdin, writes the
 * session file the descriptor checks, and exits 0. Stdin closed with nothing
 * pasted is a failed login, exit 1.
 *
 * The core runs it with the account's isolation directory as the working
 * directory, so `CLAUDE_CONFIG_DIR`-style isolation and a bare cwd both land in
 * the same place.
 */
export {};

const target = process.env['BOITE_ECHO_CONFIG_DIR'] ?? process.cwd();

async function say(line: string): Promise<void> {
  await Bun.write(Bun.stdout, `${line}\n`);
}

/** The first line on stdin, or null when it closes without one. */
async function readLine(): Promise<string | null> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const index = buffer.indexOf('\n');
    if (index >= 0) return buffer.slice(0, index).trim();
  }
  const tail = buffer.trim();
  return tail.length > 0 ? tail : null;
}

// A real CLI prints its terms before the link that signs in: the core must not take the first for the second.
await say('By continuing you accept https://example.invalid/terms');
await say('Open https://example.invalid/login?code=echo to continue');
await say('Paste the code the page shows.');

const code = await readLine();
if (code === null || code.length === 0) {
  await say('no code was pasted, the login is not finished');
  process.exit(1);
}

await Bun.write(`${target}/.credentials.json`, JSON.stringify({ provider: 'echo', code }, null, 2));
await say('logged in');
process.exit(0);
