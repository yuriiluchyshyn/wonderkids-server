import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import {
  initSchema,
  upsertUser,
  getState,
  saveState,
  isNicknameAvailable,
  resolveChildLogin,
} from './db.js';
import { isValidEmail, signToken, signChildToken, requireAuth } from './auth.js';

const NICKNAME_RE = /^[a-z0-9_]{3,12}$/;

const PORT = Number(process.env.PORT ?? 3001);
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? 'http://localhost:4321')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();

app.use(cors({ origin: CORS_ORIGIN.length ? CORS_ORIGIN : true }));
app.use(express.json({ limit: '256kb' }));

/** Liveness probe. */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/**
 * Email-only login. There is no password yet (POC): submitting an email
 * creates the account if needed and returns a token for that identity.
 */
app.post('/api/auth/login', async (req, res) => {
  const { email } = req.body ?? {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  try {
    const user = await upsertUser(email);
    const token = signToken(user);
    return res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('[login] failed:', err.message);
    return res.status(500).json({ error: 'login_failed' });
  }
});

/**
 * Check whether a child nickname is free (globally), excluding the caller's own
 * account. Used by the parent portal's add-child form for live validation.
 */
app.get('/api/nickname', requireAuth, async (req, res) => {
  const nick = String(req.query.nick ?? '').trim().toLowerCase();
  if (!NICKNAME_RE.test(nick)) {
    return res.status(400).json({ error: 'invalid_nickname' });
  }
  try {
    const available = await isNicknameAvailable(nick, req.user.id);
    return res.json({ available });
  } catch (err) {
    console.error('[nickname] failed:', err.message);
    return res.status(500).json({ error: 'check_failed' });
  }
});

/**
 * Child login: nickname OR email + parent-set password → a child session token
 * (scoped to the owning account, auto-selecting that child on the client).
 */
app.post('/api/auth/child-login', async (req, res) => {
  const { identifier, pin } = req.body ?? {};
  if (typeof identifier !== 'string' || !identifier.trim() || typeof pin !== 'string') {
    return res.status(400).json({ error: 'invalid_credentials' });
  }
  try {
    const r = await resolveChildLogin(identifier, pin);
    if (r.status === 'ok') {
      const token = signChildToken(r.userId, r.childId);
      return res.json({ token, childId: r.childId, user: { id: r.userId } });
    }
    if (r.status === 'bad_pin') return res.status(401).json({ error: 'invalid_pin' });
    return res.status(404).json({ error: 'child_not_found' });
  } catch (err) {
    console.error('[child-login] failed:', err.message);
    return res.status(500).json({ error: 'login_failed' });
  }
});

/** Fetch the signed-in user's saved game state (or null if none yet). */
app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const state = await getState(req.user.id);
    return res.json({ state });
  } catch (err) {
    console.error('[get-state] failed:', err.message);
    return res.status(500).json({ error: 'load_failed' });
  }
});

/** Replace the signed-in user's saved game state. */
app.put('/api/state', requireAuth, async (req, res) => {
  const { state } = req.body ?? {};

  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return res.status(400).json({ error: 'invalid_state' });
  }

  try {
    const updatedAt = await saveState(req.user.id, state);
    return res.json({ ok: true, updatedAt });
  } catch (err) {
    console.error('[put-state] failed:', err.message);
    return res.status(500).json({ error: 'save_failed' });
  }
});

async function start() {
  try {
    await initSchema();
    console.log('[db] schema ready');
  } catch (err) {
    console.error('[db] schema init failed — is PostgreSQL running?');
    console.error('     ', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🦄  WonderKids API listening on http://localhost:${PORT}`);
  });
}

start();
