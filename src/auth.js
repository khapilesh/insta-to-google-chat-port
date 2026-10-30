import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 32;

/** Hash a password as `scrypt$N$salt$hash` (base64 salt + key). */
export async function hashPassword(password, { salt = randomBytes(16) } = {}) {
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time password check. Never throws on malformed input. */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const [, nRaw, saltB64, keyB64] = parts;
  const n = Number(nRaw);
  if (!Number.isFinite(n)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(keyB64, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const actual = await scrypt(password, salt, expected.length, { N: n });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(value, secret) {
  return createHmac('sha256', secret).update(value).digest();
}

/**
 * Stateless signed sessions: `<payload>.<hmac>` in an HttpOnly cookie.
 * Payload carries the user, expiry and a per-session CSRF token.
 */
export function createSessionCodec({ secret, ttlMs = 12 * 60 * 60 * 1000, now = () => Date.now() }) {
  if (!secret) throw new Error('createSessionCodec needs a secret');

  return {
    issue(username) {
      const payload = {
        u: username,
        exp: now() + ttlMs,
        c: b64url(randomBytes(18)),
      };
      const body = b64url(JSON.stringify(payload));
      return { value: `${body}.${b64url(hmac(body, secret))}`, payload };
    },

    /** Returns the payload, or null when tampered with or expired. */
    read(value) {
      if (typeof value !== 'string') return null;
      const dot = value.lastIndexOf('.');
      if (dot <= 0) return null;
      const body = value.slice(0, dot);
      const sig = value.slice(dot + 1);

      const expected = hmac(body, secret);
      let provided;
      try {
        provided = Buffer.from(sig, 'base64url');
      } catch {
        return null;
      }
      if (provided.length !== expected.length) return null;
      if (!timingSafeEqual(provided, expected)) return null;

      let payload;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!payload || typeof payload.exp !== 'number' || payload.exp < now()) return null;
      return payload;
    },
  };
}

/** Parse cookies without a dependency. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  bits.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) bits.push('Secure');
  return bits.join('; ');
}

/**
 * Fixed-window login throttle, per client IP.
 * Deliberately in-memory: it only needs to slow down online guessing.
 */
export function createLoginThrottle({ maxAttempts = 8, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const attempts = new Map();

  function entry(key) {
    const existing = attempts.get(key);
    if (!existing || existing.resetAt < now()) {
      const fresh = { count: 0, resetAt: now() + windowMs };
      attempts.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  return {
    isBlocked(key) {
      return entry(key).count >= maxAttempts;
    },
    fail(key) {
      entry(key).count += 1;
    },
    reset(key) {
      attempts.delete(key);
    },
    retryAfterMs(key) {
      return Math.max(0, entry(key).resetAt - now());
    },
  };
}

/**
 * Builds the auth service the HTTP layer talks to.
 * Accepts either a plain password or a pre-hashed scrypt string, plus an
 * optional multi-user map (`alice:pass,bob:pass`).
 */
export async function createAuthService({
  password = '',
  passwordHash = '',
  users = '',
  sessionSecret,
  cookieSecure = true,
  sessionTtlMs,
  now = () => Date.now(),
  log = console,
}) {
  const accounts = new Map();

  for (const chunk of String(users || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const idx = chunk.indexOf(':');
    if (idx <= 0) continue;
    const username = chunk.slice(0, idx);
    const pw = chunk.slice(idx + 1);
    accounts.set(username, pw.startsWith('scrypt$') ? pw : await hashPassword(pw));
  }

  if (accounts.size === 0) {
    if (passwordHash) accounts.set('team', passwordHash);
    else if (password) accounts.set('team', await hashPassword(password));
  }

  let secret = sessionSecret;
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    log.warn('[auth] SESSION_SECRET not set — random secret generated, sessions end on restart');
  }

  const sessions = createSessionCodec({ secret, ttlMs: sessionTtlMs, now });
  const throttle = createLoginThrottle({ now });

  const usernames = [...accounts.keys()];

  return {
    enabled: accounts.size > 0,
    usernames,
    singleUser: usernames.length === 1 ? usernames[0] : null,
    sessionTtlMs: sessionTtlMs || 12 * 60 * 60 * 1000,
    cookieSecure,

    async authenticate(username, candidate) {
      const stored = accounts.get(username);
      if (!stored) {
        // Equalise timing whether or not the account exists.
        await verifyPassword(candidate || '', await hashPassword('placeholder'));
        return false;
      }
      return verifyPassword(candidate || '', stored);
    },

    issue(username) {
      return sessions.issue(username);
    },
    read(value) {
      return sessions.read(value);
    },

    throttle,
  };
}
