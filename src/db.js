import pg from 'pg';

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ??
  'postgres://wonderkids:wonderkids@localhost:54329/wonderkids';

/**
 * Decide whether to use TLS. Managed Postgres (Neon, RDS, …) requires it; the
 * local Docker database does not.
 */
const wantsSsl =
  /sslmode=require|neon\.tech|\.rds\.amazonaws\.com/i.test(connectionString) ||
  process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString,
  ssl: wantsSsl
    ? { rejectUnauthorized: process.env.PGSSL_INSECURE !== 'true' }
    : undefined,
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error:', err.message);
});

/**
 * Normalised schema, all tables prefixed `wk_`. Legacy single-blob tables
 * (`users`, `game_states`) are dropped — no migration (POC reset is fine).
 *
 *   wk_parents          parent accounts (email identity) + active child
 *   wk_children         one row per child profile (+ credentials, theme)
 *   wk_child_settings   per-child game + screen-time settings
 *   wk_child_stats      artifacts / tasks / hints counters
 *   wk_child_progress   path step per (module, sub)
 *   wk_child_treasures  collected treasure keys
 *   wk_milestones       family goals
 *   wk_screen_time      runtime screen-time / fuel bookkeeping
 */
export async function initSchema() {
  await pool.query(`
    DROP TABLE IF EXISTS game_states;
    DROP TABLE IF EXISTS users;

    CREATE TABLE IF NOT EXISTS wk_parents (
      id              SERIAL PRIMARY KEY,
      email           TEXT UNIQUE NOT NULL,
      active_child_id TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS wk_children (
      id          TEXT PRIMARY KEY,
      parent_id   INTEGER NOT NULL REFERENCES wk_parents(id) ON DELETE CASCADE,
      sort_index  INTEGER NOT NULL DEFAULT 0,
      name        TEXT NOT NULL DEFAULT 'Друже',
      nickname    TEXT UNIQUE,
      email       TEXT,
      pin         TEXT NOT NULL DEFAULT '',
      password    TEXT NOT NULL DEFAULT '',
      gender      TEXT NOT NULL DEFAULT 'girl',
      birth_year  INTEGER,
      birth_month INTEGER,
      theme_id    TEXT NOT NULL DEFAULT 'unicorns',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wk_children_parent_idx ON wk_children(parent_id);

    CREATE TABLE IF NOT EXISTS wk_child_settings (
      child_id             TEXT PRIMARY KEY REFERENCES wk_children(id) ON DELETE CASCADE,
      sound_on             BOOLEAN NOT NULL DEFAULT true,
      voice_on             BOOLEAN NOT NULL DEFAULT true,
      show_text            BOOLEAN NOT NULL DEFAULT true,
      companion_speed      TEXT NOT NULL DEFAULT 'medium',
      celebration          TEXT NOT NULL DEFAULT 'balloons',
      game_mode            TEXT NOT NULL DEFAULT 'dynamic_task_extension',
      min_tasks_per_level  INTEGER NOT NULL DEFAULT 10,
      choices_grid_size    INTEGER NOT NULL DEFAULT 9,
      voice                JSONB NOT NULL DEFAULT '{}'::jsonb,
      session_duration_min INTEGER NOT NULL DEFAULT 15,
      cooldown_min         INTEGER NOT NULL DEFAULT 45,
      max_daily_min        INTEGER NOT NULL DEFAULT 60
    );

    CREATE TABLE IF NOT EXISTS wk_child_stats (
      child_id        TEXT PRIMARY KEY REFERENCES wk_children(id) ON DELETE CASCADE,
      artifacts       INTEGER NOT NULL DEFAULT 0,
      tasks_completed INTEGER NOT NULL DEFAULT 0,
      hints_surfaced  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS wk_child_progress (
      child_id  TEXT NOT NULL REFERENCES wk_children(id) ON DELETE CASCADE,
      module_id TEXT NOT NULL,
      sub_id    TEXT NOT NULL,
      step      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (child_id, module_id, sub_id)
    );

    CREATE TABLE IF NOT EXISTS wk_child_treasures (
      child_id     TEXT NOT NULL REFERENCES wk_children(id) ON DELETE CASCADE,
      treasure_key TEXT NOT NULL,
      PRIMARY KEY (child_id, treasure_key)
    );

    CREATE TABLE IF NOT EXISTS wk_milestones (
      child_id     TEXT NOT NULL REFERENCES wk_children(id) ON DELETE CASCADE,
      milestone_id TEXT NOT NULL,
      amount       INTEGER NOT NULL DEFAULT 1,
      reward       TEXT NOT NULL DEFAULT '',
      sort_index   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (child_id, milestone_id)
    );

    CREATE TABLE IF NOT EXISTS wk_screen_time (
      child_id              TEXT PRIMARY KEY REFERENCES wk_children(id) ON DELETE CASCADE,
      day_key               TEXT,
      minutes_used_today    DOUBLE PRECISION NOT NULL DEFAULT 0,
      session_started_at    BIGINT,
      cooldown_until        BIGINT,
      last_session_ended_at BIGINT
    );
  `);
}

/** Find or create a parent account by (normalised) email. */
export async function upsertUser(email) {
  const normalised = email.trim().toLowerCase();
  const { rows } = await pool.query(
    `INSERT INTO wk_parents (email)
     VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, created_at`,
    [normalised],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Assembly helpers: convert normalised rows ⇄ the client's PersistableState
// blob ({ children: [...], activeChildId }), so the frontend contract is
// unchanged.
// ---------------------------------------------------------------------------

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

function assembleChild(row, settings, stats, screen, progressRows, treasureRows, milestoneRows) {
  const s = settings ?? {};
  const st = stats ?? {};
  const sc = screen ?? {};
  const progress = {};
  for (const p of progressRows) progress[`${p.module_id}:${p.sub_id}`] = p.step;

  return {
    id: row.id,
    profile: {
      name: row.name,
      nickname: row.nickname ?? '',
      pin: row.pin ?? '',
      email: row.email ?? '',
      password: row.password ?? '',
      birthYear: row.birth_year ?? undefined,
      birthMonth: row.birth_month ?? undefined,
      gender: row.gender,
    },
    themeId: row.theme_id,
    artifacts: st.artifacts ?? 0,
    tasksCompleted: st.tasks_completed ?? 0,
    hintsSurfaced: st.hints_surfaced ?? 0,
    progress,
    treasures: treasureRows.map((t) => t.treasure_key),
    milestones: milestoneRows.map((m) => ({ id: m.milestone_id, amount: m.amount, reward: m.reward })),
    settings: {
      soundOn: s.sound_on ?? true,
      voiceOn: s.voice_on ?? true,
      showText: s.show_text ?? true,
      companionSpeed: s.companion_speed ?? 'medium',
      celebration: s.celebration ?? 'balloons',
      gameMode: s.game_mode ?? 'dynamic_task_extension',
      minTasksPerLevel: s.min_tasks_per_level ?? 10,
      choicesGridSize: s.choices_grid_size ?? 9,
      voice: s.voice ?? {},
      timeControl: {
        sessionDurationMinutes: s.session_duration_min ?? 15,
        cooldownMinutes: s.cooldown_min ?? 45,
        maxDailyMinutes: s.max_daily_min ?? 60,
      },
    },
    screenTime: {
      dayKey: sc.day_key ?? '',
      minutesUsedToday: sc.minutes_used_today ?? 0,
      sessionStartedAt: numOrNull(sc.session_started_at),
      cooldownUntil: numOrNull(sc.cooldown_until),
      lastSessionEndedAt: numOrNull(sc.last_session_ended_at),
    },
  };
}

/** Load a parent's whole save, reassembled into the client blob (or null). */
export async function getState(userId) {
  const parent = await pool.query(`SELECT id, active_child_id FROM wk_parents WHERE id = $1`, [userId]);
  if (parent.rowCount === 0) return null;
  const activeChildId = parent.rows[0].active_child_id ?? null;

  const children = (
    await pool.query(
      `SELECT * FROM wk_children WHERE parent_id = $1 ORDER BY sort_index, created_at`,
      [userId],
    )
  ).rows;
  if (children.length === 0) return { children: [], activeChildId };

  const ids = children.map((c) => c.id);
  const byChild = (rows) => {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.child_id)) map.set(r.child_id, []);
      map.get(r.child_id).push(r);
    }
    return map;
  };
  const first = (rows) => {
    const map = new Map();
    for (const r of rows) map.set(r.child_id, r);
    return map;
  };

  const settings = first((await pool.query(`SELECT * FROM wk_child_settings WHERE child_id = ANY($1::text[])`, [ids])).rows);
  const stats = first((await pool.query(`SELECT * FROM wk_child_stats WHERE child_id = ANY($1::text[])`, [ids])).rows);
  const screen = first((await pool.query(`SELECT * FROM wk_screen_time WHERE child_id = ANY($1::text[])`, [ids])).rows);
  const progress = byChild((await pool.query(`SELECT * FROM wk_child_progress WHERE child_id = ANY($1::text[])`, [ids])).rows);
  const treasures = byChild((await pool.query(`SELECT * FROM wk_child_treasures WHERE child_id = ANY($1::text[])`, [ids])).rows);
  const milestones = byChild(
    (await pool.query(`SELECT * FROM wk_milestones WHERE child_id = ANY($1::text[]) ORDER BY sort_index`, [ids])).rows,
  );

  const assembled = children.map((row) =>
    assembleChild(
      row,
      settings.get(row.id),
      stats.get(row.id),
      screen.get(row.id),
      progress.get(row.id) ?? [],
      treasures.get(row.id) ?? [],
      milestones.get(row.id) ?? [],
    ),
  );

  return { children: assembled, activeChildId };
}

/** Replace a parent's whole save by decomposing the client blob into tables. */
export async function saveState(userId, state) {
  const children = Array.isArray(state?.children) ? state.children : [];
  const activeChildId = typeof state?.activeChildId === 'string' ? state.activeChildId : null;
  const childIds = children.map((c) => String(c?.id)).filter(Boolean);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`UPDATE wk_parents SET active_child_id = $2 WHERE id = $1`, [userId, activeChildId]);

    // Remove children no longer present (cascade clears their sub-rows).
    await client.query(
      `DELETE FROM wk_children WHERE parent_id = $1 AND NOT (id = ANY($2::text[]))`,
      [userId, childIds],
    );

    for (let i = 0; i < children.length; i += 1) {
      const c = children[i] ?? {};
      const id = String(c.id ?? '').trim();
      if (!id) continue;
      const p = c.profile ?? {};
      const s = c.settings ?? {};
      const tc = s.timeControl ?? {};
      const sc = c.screenTime ?? {};
      const nickname = p.nickname ? String(p.nickname).trim().toLowerCase() : null;
      const email = p.email ? String(p.email).trim().toLowerCase() : null;

      await client.query(
        `INSERT INTO wk_children
           (id, parent_id, sort_index, name, nickname, email, pin, password, gender, birth_year, birth_month, theme_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET
           parent_id=EXCLUDED.parent_id, sort_index=EXCLUDED.sort_index, name=EXCLUDED.name,
           nickname=EXCLUDED.nickname, email=EXCLUDED.email, pin=EXCLUDED.pin, password=EXCLUDED.password,
           gender=EXCLUDED.gender, birth_year=EXCLUDED.birth_year, birth_month=EXCLUDED.birth_month,
           theme_id=EXCLUDED.theme_id`,
        [
          id, userId, i, p.name ?? 'Друже', nickname, email, p.pin ?? '', p.password ?? '',
          p.gender ?? 'girl', p.birthYear ?? null, p.birthMonth ?? null, c.themeId ?? 'unicorns',
        ],
      );

      await client.query(
        `INSERT INTO wk_child_settings
           (child_id, sound_on, voice_on, show_text, companion_speed, celebration, game_mode,
            min_tasks_per_level, choices_grid_size, voice, session_duration_min, cooldown_min, max_daily_min)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (child_id) DO UPDATE SET
           sound_on=EXCLUDED.sound_on, voice_on=EXCLUDED.voice_on, show_text=EXCLUDED.show_text,
           companion_speed=EXCLUDED.companion_speed, celebration=EXCLUDED.celebration, game_mode=EXCLUDED.game_mode,
           min_tasks_per_level=EXCLUDED.min_tasks_per_level, choices_grid_size=EXCLUDED.choices_grid_size,
           voice=EXCLUDED.voice, session_duration_min=EXCLUDED.session_duration_min,
           cooldown_min=EXCLUDED.cooldown_min, max_daily_min=EXCLUDED.max_daily_min`,
        [
          id, s.soundOn ?? true, s.voiceOn ?? true, s.showText ?? true, s.companionSpeed ?? 'medium',
          s.celebration ?? 'balloons', s.gameMode ?? 'dynamic_task_extension', s.minTasksPerLevel ?? 10,
          s.choicesGridSize ?? 9, JSON.stringify(s.voice ?? {}), tc.sessionDurationMinutes ?? 15,
          tc.cooldownMinutes ?? 45, tc.maxDailyMinutes ?? 60,
        ],
      );

      await client.query(
        `INSERT INTO wk_child_stats (child_id, artifacts, tasks_completed, hints_surfaced)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (child_id) DO UPDATE SET
           artifacts=EXCLUDED.artifacts, tasks_completed=EXCLUDED.tasks_completed, hints_surfaced=EXCLUDED.hints_surfaced`,
        [id, c.artifacts ?? 0, c.tasksCompleted ?? 0, c.hintsSurfaced ?? 0],
      );

      await client.query(
        `INSERT INTO wk_screen_time
           (child_id, day_key, minutes_used_today, session_started_at, cooldown_until, last_session_ended_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (child_id) DO UPDATE SET
           day_key=EXCLUDED.day_key, minutes_used_today=EXCLUDED.minutes_used_today,
           session_started_at=EXCLUDED.session_started_at, cooldown_until=EXCLUDED.cooldown_until,
           last_session_ended_at=EXCLUDED.last_session_ended_at`,
        [
          id, sc.dayKey ?? null, sc.minutesUsedToday ?? 0, sc.sessionStartedAt ?? null,
          sc.cooldownUntil ?? null, sc.lastSessionEndedAt ?? null,
        ],
      );

      // Progress / treasures / milestones: full replace per save.
      await client.query(`DELETE FROM wk_child_progress WHERE child_id = $1`, [id]);
      const progress = c.progress && typeof c.progress === 'object' ? c.progress : {};
      for (const [key, step] of Object.entries(progress)) {
        const idx = key.indexOf(':');
        if (idx <= 0) continue;
        await client.query(
          `INSERT INTO wk_child_progress (child_id, module_id, sub_id, step) VALUES ($1,$2,$3,$4)`,
          [id, key.slice(0, idx), key.slice(idx + 1), Number(step) || 1],
        );
      }

      await client.query(`DELETE FROM wk_child_treasures WHERE child_id = $1`, [id]);
      for (const t of Array.isArray(c.treasures) ? c.treasures : []) {
        if (typeof t === 'string' && t) {
          await client.query(
            `INSERT INTO wk_child_treasures (child_id, treasure_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, t],
          );
        }
      }

      await client.query(`DELETE FROM wk_milestones WHERE child_id = $1`, [id]);
      const milestones = Array.isArray(c.milestones) ? c.milestones : [];
      for (let m = 0; m < milestones.length; m += 1) {
        const ms = milestones[m] ?? {};
        if (!ms.id) continue;
        await client.query(
          `INSERT INTO wk_milestones (child_id, milestone_id, amount, reward, sort_index)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, String(ms.id), Number(ms.amount) || 1, String(ms.reward ?? ''), m],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return new Date().toISOString();
}

/**
 * Is a child nickname free across all accounts? Optionally excludes one parent
 * (so a parent re-saving their own child's nickname doesn't collide).
 */
export async function isNicknameAvailable(nickname, exceptUserId = null) {
  const nick = String(nickname).trim().toLowerCase();
  const { rows } = await pool.query(
    `SELECT 1 FROM wk_children
      WHERE lower(nickname) = $1
        AND ($2::int IS NULL OR parent_id <> $2)
      LIMIT 1`,
    [nick, exceptUserId],
  );
  return rows.length === 0;
}

/**
 * Resolve a child login by nickname OR email + parent-set password. Returns
 * `{ status }` ('ok' + { userId, childId } | 'bad_password' | 'not_found').
 */
export async function resolveChildLogin(identifier, password) {
  const id = String(identifier ?? '').trim().toLowerCase();
  if (!id) return { status: 'not_found' };
  const { rows } = await pool.query(
    `SELECT id, parent_id, password FROM wk_children
      WHERE lower(nickname) = $1 OR lower(email) = $1`,
    [id],
  );
  if (rows.length === 0) return { status: 'not_found' };
  const match = rows.find((r) => String(r.password ?? '') === String(password ?? ''));
  if (!match) return { status: 'bad_password' };
  return { status: 'ok', userId: match.parent_id, childId: match.id };
}
