import type { Database } from 'bun:sqlite';

/**
 * Teams of bots (`docs/teams.md`). Member keys are `<coreId>/<botId>`, so
 * every row already fits members on other machines.
 *
 * - `teams`: the team as JSON (`Team` without its live seq), its version and its chat thread.
 * - `team_posts`: every post in the host's order; `id` is the writer's, `fingerprint` refuses a reused id with other content.
 * - `team_cursors`: per member, the seq below which it saw every post it may read.
 * - `team_seen`: per member, posts above its cursor that are `seen`, or in `flight` in letter `letter_id`.
 * - `team_deliveries`: where a post stands for each recipient.
 * - `team_replies`: the envelope of a team wake: where the final answer of its turn goes, and whether it was posted.
 */
export function createTeams(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    version INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS team_posts (
    team_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    audience TEXT NOT NULL,
    to_keys TEXT NOT NULL,
    routed_by TEXT NOT NULL,
    why TEXT,
    in_reply_to TEXT,
    turn_id TEXT,
    notice TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, seq)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS team_posts_turn ON team_posts(turn_id) WHERE turn_id IS NOT NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS team_cursors (
    team_id TEXT NOT NULL,
    member TEXT NOT NULL,
    low INTEGER NOT NULL,
    PRIMARY KEY (team_id, member)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS team_seen (
    team_id TEXT NOT NULL,
    member TEXT NOT NULL,
    seq INTEGER NOT NULL,
    state TEXT NOT NULL,
    letter_id TEXT,
    PRIMARY KEY (team_id, member, seq)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS team_seen_letter ON team_seen(letter_id) WHERE letter_id IS NOT NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS team_deliveries (
    post_id TEXT NOT NULL,
    member TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    letter_id TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (post_id, member)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS team_replies (
    turn_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    audience TEXT NOT NULL,
    recipient TEXT,
    in_reply_to TEXT,
    created_at INTEGER NOT NULL,
    published INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS team_replies_pending ON team_replies(turn_id) WHERE published = 0');
  db.exec("CREATE INDEX IF NOT EXISTS team_deliveries_waiting ON team_deliveries(at) WHERE state = 'waiting'");
}
