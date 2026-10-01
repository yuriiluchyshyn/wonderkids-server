import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { initSchema, upsertUser, getState, saveState } from './db.js';
import { isValidEmail, signToken, requireAuth } from './auth.js';

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
