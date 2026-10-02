import pg from 'pg';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://wonderkids:wonderkids@localhost:54329/wonderkids';

/**
 * Decide whether to use TLS. Managed Postgres (Neon, RDS, …) requires it; the
 * local Docker database does not. We turn SSL on when the URL asks for it
 * (`sslmode=require`), when it points at a known managed host, or when
 * `PGSSL=true` is set explicitly.
 */
const wantsSsl =
  /sslmode=require|neon\.tech|\.rds\.amazonaws\.com/i.test(connectionString) ||
  process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString,
  // Neon's certificates chain to a public CA, so verification stays on by
  // default. Set PGSSL_INSECURE=true only if a provider needs it disabled.
  ssl: wantsSsl
    ? { rejectUnauthorized: process.env.PGSSL_INSECURE !== 'true' }
    : undefined,
});

pool.on('error', (err) => {
  // A pooled client died in the background. Log and let the pool recover.
  console.error('[db] unexpected pool error:', err.message);
});

/**
 * Create the tables we need if they are not there yet. Safe to run on every
 * boot — it is idempotent, so there is no separate migration step for the POC.
 *
 * - `users`        one row per email (login identity).
 * - `game_states`  one row per user holding the full save as JSONB — this is
 *                  exactly what used to live in the browser's localStorage.
 */
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS game_states (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state       JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Find an existing user by email or create one. Returns the user row.
 * Email is normalised (trimmed + lowercased) so logins are case-insensitive.
 */
export async function upsertUser(email) {
  const normalised = email.trim().toLowerCase();
  const { rows } = await pool.query(
    `INSERT INTO users (email)
     VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, created_at`,
    [normalised],
  );
  return rows[0];
}

/** Return the stored save for a user, or null if nothing saved yet. */
export async function getState(userId) {
  const { rows } = await pool.query(
    `SELECT state FROM game_states WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.state ?? null;
}

/**
 * Is a child nickname free across all accounts? Scans the `children` JSONB
 * arrays with a containment match, optionally excluding one account (so a
 * parent re-saving their own child's nickname doesn't collide with itself).
 */
export async function isNicknameAvailable(nickname, exceptUserId = null) {
  const probe = JSON.stringify([{ profile: { nickname: String(nickname).toLowerCase() } }]);
  const { rows } = await pool.query(
    `SELECT 1 FROM game_states
      WHERE state->'children' @> $1::jsonb
        AND ($2::int IS NULL OR user_id <> $2)
      LIMIT 1`,
    [probe, exceptUserId],
  );
  return rows.length === 0;
}

/**
 * Resolve a child login (Tech Spec v2.1 US-1 / FR-AUTH): match the child whose
 * nickname OR email equals `identifier`, then check the parent-set password.
 * Returns `{ status }` where status is:
 *   'ok'           → plus { userId, childId }
 *   'bad_password' → identifier exists but the password is wrong
 *   'not_found'    → no child with that nickname/email (ask a parent to create one)
 */
export async function resolveChildLogin(identifier, password) {
  const id = String(identifier ?? '').trim().toLowerCase();
  if (!id) return { status: 'not_found' };
  let identifierExists = false;
  for (const field of ['nickname', 'email']) {
    const probe = JSON.stringify([{ profile: { [field]: id } }]);
    const { rows } = await pool.query(
      `SELECT user_id, state FROM game_states WHERE state->'children' @> $1::jsonb`,
      [probe],
    );
    for (const row of rows) {
      const children = Array.isArray(row.state?.children) ? row.state.children : [];
      for (const c of children) {
        if (String(c?.profile?.[field] ?? '').toLowerCase() === id) {
          identifierExists = true;
          if (String(c?.profile?.password ?? '') === String(password ?? '') && c.id) {
            return { status: 'ok', userId: row.user_id, childId: c.id };
          }
        }
      }
    }
  }
  return { status: identifierExists ? 'bad_password' : 'not_found' };
}

/** Insert or replace the full save for a user. Returns the updated timestamp. */
export async function saveState(userId, state) {
  const { rows } = await pool.query(
    `INSERT INTO game_states (user_id, state, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()
     RETURNING updated_at`,
    [userId, state],
  );
  return rows[0].updated_at;
}
