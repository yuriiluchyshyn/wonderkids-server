import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '30d';

// Deliberately permissive: good enough to catch typos without rejecting valid
// but unusual addresses. Real validation happens by the user receiving mail —
// which this POC does not do (email-only identity, no verification yet).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

/** Sign a token identifying a user. */
export function signToken(user) {
  return jwt.sign({ email: user.email }, JWT_SECRET, {
    subject: String(user.id),
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * Express middleware: require a valid Bearer token. On success attaches
 * `req.user = { id, email }`; otherwise responds 401.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: Number(payload.sub), email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
